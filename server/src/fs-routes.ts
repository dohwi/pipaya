import type { FastifyInstance } from "fastify";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Type from "typebox";
import { badRequest } from "./errors.ts";
import { errors } from "./schemas.ts";
import { isInside } from "./tools.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

export const DirQuery = Type.Object({
	path: Type.Optional(Type.String({ description: "Absolute directory to list; defaults to the default working directory" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include dot-directories" })),
});
export const DirListing = Type.Object({
	path: Type.String(),
	parent: Type.Union([Type.String(), Type.Null()], { description: "null at the filesystem root" }),
	home: Type.String(),
	entries: Type.Array(Type.Object({ name: Type.String(), path: Type.String() })),
	truncated: Type.Boolean({ description: "More than 500 sub-directories: the list was cut" }),
});
export const MkdirBody = Type.Object({
	parent: Type.String({ minLength: 1, description: "Absolute directory to create the folder in" }),
	name: Type.String({ minLength: 1, maxLength: 255, description: "Single folder name, no slashes" }),
}, { additionalProperties: false });
export const MkdirResult = Type.Object({ path: Type.String() });

export const FileQuery = Type.Object({
	cwd: Type.Optional(Type.String({ description: "Absolute directory to search in; defaults to the default working directory" })),
	q: Type.Optional(Type.String({ description: "Path fragment to match, e.g. 'src/comp'" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const FileListing = Type.Object({
	entries: Type.Array(Type.Object({ path: Type.String({ description: "Relative to cwd; directories end with /" }), dir: Type.Boolean() })),
});

const LIMIT = 500;
const SCAN_LIMIT = 20000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", "target", "__pycache__", ".venv", ".next", ".svelte-kit", ".cache"]);

interface Indexed { path: string; dir: boolean; lower: string }
const INDEX_TTL = 5000;
/** Finished scans, and scans still running: concurrent requests for one root (every keystroke after "@") share one walk. */
const indexCache = new Map<string, { at: number; items: Promise<Indexed[]> }>();

/**
 * Breadth-first so shallow files survive the scan cap. Symlinks are not followed. Async and yielding between folders,
 * so a big tree never stalls the event loop (and with it every streaming session) while the user types a mention.
 */
async function scan(root: string): Promise<Indexed[]> {
	const items: Indexed[] = [];
	const queue = [""];
	for (let head = 0; head < queue.length && items.length < SCAN_LIMIT; head++) {
		const rel = queue[head]!;
		let entries;
		try {
			entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
		} catch { continue; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			const isDir = e.isDirectory();
			if (!isDir && !e.isFile()) continue;
			if (isDir && SKIP_DIRS.has(e.name)) continue;
			const p = rel ? `${rel}/${e.name}` : e.name;
			const path = isDir ? `${p}/` : p;
			items.push({ path, dir: isDir, lower: path.toLowerCase() });
			if (isDir) queue.push(p);
			if (items.length >= SCAN_LIMIT) break;
		}
	}
	return items;
}

function indexFiles(root: string): Promise<Indexed[]> {
	const hit = indexCache.get(root);
	if (hit && Date.now() - hit.at < INDEX_TTL) return hit.items;
	const items = scan(root);
	if (indexCache.size > 20) indexCache.clear();
	const entry = { at: Date.now(), items };
	indexCache.set(root, entry);
	// The TTL counts from when the walk finished, not from when it started.
	void items.then(() => { entry.at = Date.now(); }, () => indexCache.delete(root));
	return items;
}

function rank(item: Indexed, q: string): number {
	const name = item.lower.replace(/\/$/, "").split("/").pop()!;
	if (!q) return item.lower.split("/").length - (item.dir ? 1.5 : 1); // shallow first, folders before files
	if (item.lower === q || item.lower === `${q}/`) return 0;
	if (item.lower.startsWith(q)) return 1;
	if (name.startsWith(q)) return 2;
	if (name.includes(q)) return 3;
	if (item.lower.includes(q)) return 4;
	// subsequence match: "cmps" -> "Composer.svelte"
	let i = 0;
	for (const ch of item.lower) if (ch === q[i] && ++i === q.length) return 5;
	return 99;
}

/** `~`, `~/x`, `/x` and `../x` leave the working directory: they are listed one folder at a time, like the folder picker. */
export function isPathQuery(q: string): boolean {
	return q === "~" || q === ".." || q.startsWith("~/") || q.startsWith("/") || q.startsWith("../");
}

/** Split "~/work/sr" into the folder to read ("<home>/work"), the text to keep in front of each result ("~/work/") and the filter ("sr"). */
export function splitPathQuery(raw: string, root: string): { dir: string; prefix: string; filter: string } {
	const bare = raw === "~" || raw === "..";
	const prefix = bare ? `${raw}/` : raw.slice(0, raw.lastIndexOf("/") + 1);
	const filter = bare ? "" : raw.slice(prefix.length);
	const dir = prefix.startsWith("~/") ? join(homedir(), prefix.slice(2)) : resolve(root, prefix);
	return { dir, prefix, filter };
}

/** Directory browsing for the client's working-directory picker. Folders only, never file contents. */
export function registerFsRoutes(server: FastifyInstance, defaultWorkdir: () => string, confinedTo?: string): void {
	const inBounds = (path: string) => !confinedTo || isInside(confinedTo, path);
	const app = server.withTypeProvider<TypeBoxProvider>();

	app.get("/fs/dirs", {
		schema: { querystring: DirQuery, response: { 200: DirListing, ...errors(400, 401) } },
		handler: async (req) => {
			const given = req.query.path?.trim();
			const raw = given || defaultWorkdir();
			// The default directory is created lazily by the first session; browsing it must work before that.
			if (!given) mkdirSync(raw, { recursive: true });
			if (!isAbsolute(raw)) throw badRequest("path must be absolute");
			const path = resolve(raw);
			if (!inBounds(path)) throw badRequest(`browsing is limited to the workspace: ${confinedTo}`);
			let names: string[];
			try {
				if (!statSync(path).isDirectory()) throw new Error("not a directory");
				names = readdirSync(path);
			} catch {
				throw badRequest(`cannot open directory: ${path}`);
			}
			const dirs: { name: string; path: string }[] = [];
			for (const name of names.sort((a, b) => a.localeCompare(b))) {
				if (!req.query.hidden && name.startsWith(".")) continue;
				const full = join(path, name);
				try {
					if (statSync(full).isDirectory()) dirs.push({ name, path: full });
				} catch { /* broken link or no permission: skip */ }
				if (dirs.length > LIMIT) break;
			}
			const up = dirname(path);
			const parent = up === path || !inBounds(up) ? null : up; // never lead the picker out of the workspace
			return {
				path, parent, home: homedir(),
				entries: dirs.slice(0, LIMIT), truncated: dirs.length > LIMIT,
			};
		},
	});

	/** File and folder suggestions for `@` mentions in the composer. Names only, never contents. */
	app.get("/fs/files", {
		schema: { querystring: FileQuery, response: { 200: FileListing, ...errors(400, 401) } },
		handler: async (req) => {
			const raw = req.query.cwd?.trim() || defaultWorkdir();
			if (!isAbsolute(raw)) throw badRequest("cwd must be absolute");
			const root = resolve(raw);
			if (!inBounds(root)) throw badRequest(`browsing is limited to the workspace: ${confinedTo}`);
			try {
				if (!statSync(root).isDirectory()) throw new Error();
			} catch {
				throw badRequest(`cannot open directory: ${root}`);
			}
			const rawQ = (req.query.q ?? "").trim().replace(/^\.\//, "");
			const limit = req.query.limit ?? 50;
			if (isPathQuery(rawQ)) {
				const { dir, prefix, filter } = splitPathQuery(rawQ, root);
				if (!inBounds(dir)) throw badRequest(`browsing is limited to the workspace: ${confinedTo}`);
				let found;
				try {
					found = readdirSync(dir, { withFileTypes: true });
				} catch {
					return { entries: [] }; // not a folder (yet): the user is still typing
				}
				const f = filter.toLowerCase();
				const ranked: { path: string; dir: boolean; s: number }[] = [];
				for (const e of found) {
					if (e.name.startsWith(".") && !f.startsWith(".")) continue;
					let isDir = e.isDirectory();
					if (e.isSymbolicLink()) {
						try { isDir = statSync(join(dir, e.name)).isDirectory(); } catch { continue; }
					} else if (!isDir && !e.isFile()) continue;
					const name = `${e.name}${isDir ? "/" : ""}`;
					const s = f ? rank({ path: name, dir: isDir, lower: name.toLowerCase() }, f) : 0; // no filter yet: folders first, then by name
					if (s < 99) ranked.push({ path: prefix + name, dir: isDir, s });
				}
				ranked.sort((a, b) => a.s - b.s || Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
				return { entries: ranked.slice(0, limit).map((r) => ({ path: r.path, dir: r.dir })) };
			}
			const q = rawQ.toLowerCase();
			const ranked: { item: Indexed; s: number }[] = [];
			for (const item of await indexFiles(root)) {
				const s = rank(item, q);
				if (s < 99) ranked.push({ item, s });
			}
			ranked.sort((a, b) => a.s - b.s || a.item.path.length - b.item.path.length || a.item.path.localeCompare(b.item.path));
			return { entries: ranked.slice(0, limit).map((r) => ({ path: r.item.path, dir: r.item.dir })) };
		},
	});

	app.post("/fs/dirs", {
		schema: { body: MkdirBody, response: { 201: MkdirResult, ...errors(400, 401) } },
		handler: async (req, reply) => {
			const { parent, name } = req.body;
			if (!isAbsolute(parent)) throw badRequest("parent must be absolute");
			if (name === "." || name === ".." || /[\/\\\0]/.test(name) || basename(name) !== name) throw badRequest("name must be a single folder name");
			if (!inBounds(resolve(parent))) throw badRequest(`folders can only be created inside the workspace: ${confinedTo}`);
			const path = join(resolve(parent), name);
			try {
				if (!statSync(resolve(parent)).isDirectory()) throw new Error();
			} catch {
				throw badRequest(`parent is not an existing directory: ${resolve(parent)}`);
			}
			try {
				mkdirSync(path);
			} catch (e) {
				throw badRequest((e as NodeJS.ErrnoException).code === "EEXIST" ? `already exists: ${path}` : `cannot create ${path}`);
			}
			return reply.status(201).send({ path });
		},
	});
}
