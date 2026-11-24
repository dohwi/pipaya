import type { FastifyInstance } from "fastify";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Type from "typebox";
import { badRequest } from "../errors.ts";
import { repoOf } from "../git-info.ts";
import { errors } from "../schemas.ts";
import { isInside } from "../tools.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

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

export const ReposBody = Type.Object({
	paths: Type.Array(Type.String({ minLength: 1 }), { maxItems: 500, description: "Absolute folders to look up" }),
}, { additionalProperties: false });
const RepoInfo = Type.Object({
	root: Type.String({ description: "The repository's main working tree: one value for the main checkout and all its worktrees" }),
	top: Type.String({ description: "The working tree holding the folder (the main checkout or a worktree)" }),
	branch: Type.Union([Type.String(), Type.Null()], { description: "null when HEAD is detached" }),
});
export const ReposResult = Type.Object({
	repos: Type.Record(Type.String(), Type.Union([RepoInfo, Type.Null()]), { description: "Per asked folder; null outside a repository" }),
});

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

export interface Indexed {
	path: string;
	dir: boolean;
	lower: string;
	/** Lowercase basename without trailing slash, precomputed during scan(). */
	name: string;
	/** Number of `/` segments + 1 (matches `lower.split("/").length`), precomputed during scan(). */
	depth: number;
}
export const INDEX_TTL = 5000;
export const INDEX_CACHE_MAX = 20;

/**
 * TTL + LRU bounded cache for directory file indexes.
 * Stores in-flight and completed scan promises so concurrent requests for one root share one walk.
 */
export class FileIndexCache<T = Indexed[]> {
	private map = new Map<string, { at: number; items: Promise<T> }>();

	constructor(
		private readonly ttl = INDEX_TTL,
		private readonly maxEntries = INDEX_CACHE_MAX,
		private readonly now: () => number = Date.now,
	) {}

	get size(): number {
		return this.map.size;
	}

	has(root: string): boolean {
		return this.map.has(root);
	}

	get(root: string): Promise<T> | undefined {
		const hit = this.map.get(root);
		if (!hit) return undefined;
		if (this.now() - hit.at >= this.ttl) {
			this.map.delete(root);
			return undefined;
		}
		// Refresh LRU position on hit.
		this.map.delete(root);
		this.map.set(root, hit);
		return hit.items;
	}

	set(root: string, items: Promise<T>): Promise<T> {
		const t = this.now();
		this.map.delete(root);
		// Evict expired entries first so stale trees do not displace active roots.
		for (const [k, v] of this.map) {
			if (t - v.at >= this.ttl) this.map.delete(k);
		}
		// Evict least-recently-used entries until there is room for the new root.
		while (this.map.size >= this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
		const entry = { at: t, items };
		this.map.set(root, entry);
		// The TTL counts from when the walk finished, not from when it started.
		void items.then(
			() => { entry.at = this.now(); },
			() => { if (this.map.get(root) === entry) this.map.delete(root); },
		);
		return items;
	}
}

/** Finished scans, and scans still running: concurrent requests for one root (every keystroke after "@") share one walk. */
const indexCache = new FileIndexCache<Indexed[]>();

/**
 * Breadth-first so shallow files survive the scan cap. Symlinks are not followed. Async and yielding between folders,
 * so a big tree never stalls the event loop (and with it every streaming session) while the user types a mention.
 */
async function scan(root: string): Promise<Indexed[]> {
	const items: Indexed[] = [];
	const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
	for (let head = 0; head < queue.length && items.length < SCAN_LIMIT; head++) {
		const { rel, depth } = queue[head]!;
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
			items.push({
				path,
				dir: isDir,
				lower: path.toLowerCase(),
				name: e.name.toLowerCase(),
				depth: depth + (isDir ? 2 : 1),
			});
			if (isDir) queue.push({ rel: p, depth: depth + 1 });
			if (items.length >= SCAN_LIMIT) break;
		}
	}
	return items;
}

function indexFiles(root: string): Promise<Indexed[]> {
	const hit = indexCache.get(root);
	if (hit) return hit;
	return indexCache.set(root, scan(root));
}

export function rank(item: Indexed, q: string): number {
	if (!q) return item.depth - (item.dir ? 1.5 : 1); // shallow first, folders before files
	if (item.lower === q || item.lower === `${q}/`) return 0;
	if (item.lower.startsWith(q)) return 1;
	if (item.name.startsWith(q)) return 2;
	if (item.name.includes(q)) return 3;
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
			if (!given) await mkdir(raw, { recursive: true });
			if (!isAbsolute(raw)) throw badRequest("path must be absolute");
			const path = resolve(raw);
			if (!inBounds(path)) throw badRequest(`browsing is limited to the workspace: ${confinedTo}`);
			let entries;
			try {
				if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
				entries = await readdir(path, { withFileTypes: true });
			} catch {
				throw badRequest(`cannot open directory: ${path}`);
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			const dirs: { name: string; path: string }[] = [];
			for (const entry of entries) {
				if (!req.query.hidden && entry.name.startsWith(".")) continue;
				const full = join(path, entry.name);
				let isDir = entry.isDirectory();
				if (!isDir && (entry.isSymbolicLink() || (!entry.isFile() && !entry.isBlockDevice() && !entry.isCharacterDevice() && !entry.isFIFO() && !entry.isSocket()))) {
					try {
						isDir = (await stat(full)).isDirectory();
					} catch { /* broken link or no permission: skip */ }
				}
				if (isDir) dirs.push({ name: entry.name, path: full });
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
					const s = f ? rank({ path: name, dir: isDir, lower: name.toLowerCase(), name: e.name.toLowerCase(), depth: isDir ? 2 : 1 }, f) : 0; // no filter yet: folders first, then by name
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

	/**
	 * The git repository each folder belongs to, so the sidebar can list a repository's worktrees under one project.
	 * Read from `.git` files only (git itself is not started); a folder outside the workspace or outside any repository is null.
	 */
	app.post("/fs/repos", {
		schema: { body: ReposBody, response: { 200: ReposResult, ...errors(400, 401) } },
		handler: async (req) => {
			const repos: Record<string, { root: string; top: string; branch: string | null } | null> = {};
			for (const p of new Set(req.body.paths)) {
				if (!isAbsolute(p) || !inBounds(resolve(p))) { repos[p] = null; continue; }
				const r = repoOf(p);
				repos[p] = r && inBounds(r.root) ? r : null;
			}
			return { repos };
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
