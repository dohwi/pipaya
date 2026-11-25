import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { badRequest, notFound } from "../errors.ts";
import type { SessionStore } from "../store.ts";
import { workDirOf } from "../work-tree.ts";

export interface DiffLine {
	type: "context" | "add" | "del" | "meta";
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

export interface DiffHunk {
	header: string;
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface WorkspaceEntry {
	name: string;
	path: string;
	dir: boolean;
}

export interface WorkspaceChange {
	path: string;
	oldPath?: string;
	status: "M" | "A" | "D" | "R" | "?" | "U";
	additions: number;
	deletions: number;
}

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	".svelte-kit",
	".cache",
	"__pycache__",
	".venv",
	"target",
]);

const MAX_DIR_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_SCAN = 15_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 200 * 1024;
const GIT_TIMEOUT_MS = 10_000;

function realpathSafe(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

function lstatSafe(p: string) {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

/** Ensure a relative path stays strictly inside `root` (blocks `..`, null bytes, absolute paths, symlink escapes, and symlinked ancestors). */
export function safeInsideRoot(root: string, relPath: string): string | null {
	if (relPath.includes("\0") || isAbsolute(relPath)) return null;
	const realRoot = realpathSafe(root);
	if (!realRoot) return null;
	const normalized = relPath.replace(/^\/+|\/+$/g, "");
	if (!normalized) return realRoot;
	const candidate = resolve(realRoot, normalized);
	const rel = relative(realRoot, candidate);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;

	// Check existing target (including dangling symlinks where existsSync is false).
	const st = lstatSafe(candidate);
	if (st) {
		const realTarget = realpathSafe(candidate);
		if (!realTarget) return null; // dangling symlink
		const realRel = relative(realRoot, realTarget);
		if (realRel.startsWith("..") || isAbsolute(realRel)) return null;
		return candidate;
	}

	// Target does not exist yet: verify its nearest existing ancestor resolves inside realRoot.
	let cur = dirname(candidate);
	while (cur && cur !== realRoot) {
		const anc = lstatSafe(cur);
		if (anc) {
			const realAnc = realpathSafe(cur);
			if (!realAnc) return null;
			const ancRel = relative(realRoot, realAnc);
			if (ancRel.startsWith("..") || isAbsolute(ancRel)) return null;
			break;
		}
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
	return candidate;
}

function readHeadBytes(absPath: string, maxBytes: number): { buf: Buffer; truncated: boolean; size: number } {
	const st = lstatSync(absPath);
	const truncated = st.size > maxBytes;
	const toRead = Math.min(st.size, maxBytes);
	const buf = Buffer.alloc(toRead);
	if (toRead === 0) return { buf, truncated: false, size: 0 };
	const fd = openSync(absPath, "r");
	try {
		const n = readSync(fd, buf, 0, toRead, 0);
		return { buf: buf.subarray(0, n), truncated, size: st.size };
	} finally {
		closeSync(fd);
	}
}

async function runGit(cwd: string, args: string[], maxBytes = MAX_DIFF_BYTES): Promise<{ code: number; stdout: string; truncated: boolean }> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(["git", ...args], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch {
		return { code: -1, stdout: "", truncated: false };
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { proc.kill(); } catch { /* exited */ }
	}, GIT_TIMEOUT_MS);
	timer.unref?.();

	const stream = proc.stdout as ReadableStream<Uint8Array> | null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	if (stream) {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				if (total + value.byteLength <= maxBytes) {
					chunks.push(value);
					total += value.byteLength;
				} else {
					const rem = Math.max(0, maxBytes - total);
					if (rem > 0) {
						chunks.push(value.subarray(0, rem));
						total += rem;
					}
					truncated = true;
				}
			}
		} catch { /* closed */ } finally {
			reader.releaseLock();
		}
	}
	const code = await proc.exited;
	clearTimeout(timer);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return { code: timedOut ? 124 : code, stdout: new TextDecoder().decode(merged), truncated };
}

export function parseUnifiedDiff(raw: string): { hunks: DiffHunk[]; additions: number; deletions: number; binary: boolean } {
	if (!raw) return { hunks: [], additions: 0, deletions: 0, binary: false };
	const lines = raw.split(/\r?\n/);
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	let additions = 0;
	let deletions = 0;
	let binary = false;

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			current = null;
			continue;
		}
		if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			binary = true;
			continue;
		}
		const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
		if (hm) {
			oldLine = Number(hm[1]);
			newLine = Number(hm[2]);
			current = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+")) {
			additions++;
			current.lines.push({ type: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
		} else if (line.startsWith("-")) {
			deletions++;
			current.lines.push({ type: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
		} else if (line.startsWith("\\")) {
			current.lines.push({ type: "meta", oldLine: null, newLine: null, text: line });
		} else if (line.startsWith(" ")) {
			current.lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
		}
	}
	return { hunks, additions, deletions, binary };
}

function mapStatus(x: string, y: string): WorkspaceChange["status"] {
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "U";
	if (x === "?" && y === "?") return "?";
	if (x === "R" || y === "R") return "R";
	if (x === "A" || y === "A") return "A";
	if (x === "D" || y === "D") return "D";
	return "M";
}

function listDirEntries(root: string, relDir: string): { entries: WorkspaceEntry[]; truncated: boolean } {
	const absDir = safeInsideRoot(root, relDir);
	if (!absDir || !existsSync(absDir)) return { entries: [], truncated: false };
	const st = lstatSync(absDir);
	if (!st.isDirectory()) return { entries: [], truncated: false };
	const prefix = relDir.replace(/^\/+|\/+$/g, "");
	const dirents = readdirSync(absDir, { withFileTypes: true });
	const entries: WorkspaceEntry[] = [];
	for (const d of dirents) {
		if (d.name === ".git") continue;
		const relPath = prefix ? `${prefix}/${d.name}` : d.name;
		if (d.isSymbolicLink()) {
			// Skip symlinks pointing outside the working directory so the tree never lists unreadable links.
			const resolved = safeInsideRoot(root, relPath);
			if (!resolved) continue;
			try {
				const targetStat = lstatSync(resolved);
				entries.push({ name: d.name, path: relPath, dir: targetStat.isDirectory() });
			} catch {
				continue;
			}
			continue;
		}
		entries.push({ name: d.name, path: relPath, dir: d.isDirectory() });
	}
	entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
	const truncated = entries.length > MAX_DIR_ENTRIES;
	return { entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries, truncated };
}

function searchFiles(root: string, query: string): WorkspaceEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const results: WorkspaceEntry[] = [];
	const queue: string[] = [""];
	let scanned = 0;

	while (queue.length > 0 && results.length < MAX_SEARCH_RESULTS && scanned < MAX_SEARCH_SCAN) {
		const relDir = queue.shift()!;
		const absDir = relDir ? join(root, relDir) : root;
		let dirents;
		try {
			dirents = readdirSync(absDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirents) {
			scanned++;
			if (scanned > MAX_SEARCH_SCAN) break;
			if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
			const relPath = relDir ? `${relDir}/${d.name}` : d.name;
			const isDir = d.isDirectory();
			if (relPath.toLowerCase().includes(needle)) {
				results.push({ name: d.name, path: relPath, dir: isDir });
				if (results.length >= MAX_SEARCH_RESULTS) break;
			}
			if (isDir) queue.push(relPath);
		}
	}
	results.sort((a, b) => Number(a.dir) - Number(b.dir) || a.path.length - b.path.length || a.path.localeCompare(b.path));
	return results;
}

async function inspectGitChanges(workDir: string): Promise<{ isRepo: boolean; repoRoot: string | null; branch: string | null; changes: WorkspaceChange[] }> {
	const top = await runGit(workDir, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0 || !top.stdout.trim()) {
		return { isRepo: false, repoRoot: null, branch: null, changes: [] };
	}
	const repoRoot = top.stdout.trim();
	const realWork = realpathSafe(workDir) ?? resolve(workDir);
	const realRoot = realpathSafe(repoRoot) ?? resolve(repoRoot);
	const subPrefix = relative(realRoot, realWork).replace(/\\/g, "/");

	const [branchRes, statusRes, headRes] = await Promise.all([
		runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]),
		runGit(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"]),
		runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]),
	]);
	const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
	const hasHead = headRes.code === 0;

	const numstatMap = new Map<string, { additions: number; deletions: number }>();
	const numRes = await runGit(
		repoRoot,
		hasHead ? ["diff", "HEAD", "--numstat", "-z"] : ["diff", "--cached", "--numstat", "-z"],
	);
	if (numRes.code === 0 && numRes.stdout) {
		const parts = numRes.stdout.split("\0");
		for (let i = 0; i < parts.length; i++) {
			const row = parts[i];
			if (!row) continue;
			const tab = row.split("\t");
			if (tab.length < 3) continue;
			const add = tab[0] === "-" ? 0 : Number(tab[0]) || 0;
			const del = tab[1] === "-" ? 0 : Number(tab[1]) || 0;
			const filePath = tab[2] === "" && i + 2 < parts.length ? parts[(i += 2)]! : tab[2]!;
			numstatMap.set(filePath, { additions: add, deletions: del });
		}
	}

	const changes: WorkspaceChange[] = [];
	const parts = statusRes.stdout.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry || entry.length < 4) continue;
		const x = entry[0]!;
		const y = entry[1]!;
		const repoRel = entry.slice(3);
		let oldPath: string | undefined;
		if ((x === "R" || x === "C" || y === "R" || y === "C") && i + 1 < parts.length) {
			oldPath = parts[++i];
		}
		// Convert path relative to `workDir` if `workDir` is a subdirectory of `repoRoot`.
		let displayPath = repoRel;
		if (subPrefix && !subPrefix.startsWith("..")) {
			if (repoRel === subPrefix || !repoRel.startsWith(`${subPrefix}/`)) continue;
			displayPath = repoRel.slice(subPrefix.length + 1);
		}
		const status = mapStatus(x, y);
		let additions = numstatMap.get(repoRel)?.additions ?? 0;
		const deletions = numstatMap.get(repoRel)?.deletions ?? 0;
		if (status === "?") {
			const abs = safeInsideRoot(realWork, displayPath);
			if (abs && existsSync(abs)) {
				try {
					const st = lstatSync(abs);
					if (st.isFile() && st.size <= 64 * 1024) {
						const { buf } = readHeadBytes(abs, 64 * 1024);
						if (!buf.includes(0)) {
							const txt = buf.toString("utf-8");
							additions = txt ? txt.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
						}
					}
				} catch { /* ignore */ }
			}
		}
		changes.push({
			path: displayPath,
			...(oldPath ? { oldPath } : {}),
			status,
			additions,
			deletions,
		});
	}

	return { isRepo: true, repoRoot: realRoot, branch, changes };
}

export function registerWorkspaceViewerRoutes(server: FastifyInstance, deps: { store: SessionStore }): void {
	const { store } = deps;

	const workDirFor = (sessionId: string): string => {
		const rec = store.get(sessionId);
		if (!rec) throw notFound("session not found");
		const dir = workDirOf(rec);
		if (!dir || !existsSync(dir)) throw notFound("working directory not found");
		return dir;
	};

	server.get("/sessions/:id/workspace/tree", {
		schema: {
			params: Type.Object({ id: Type.String() }),
			querystring: Type.Object({
				dir: Type.Optional(Type.String()),
				q: Type.Optional(Type.String()),
			}),
		},
	}, async (req) => {
		const { id } = req.params as { id: string };
		const { dir, q } = req.query as { dir?: string; q?: string };
		const root = workDirFor(id);

		const [git, listing] = await Promise.all([
			inspectGitChanges(root),
			Promise.resolve(
				q?.trim()
					? { entries: searchFiles(root, q), truncated: false }
					: listDirEntries(root, dir ?? ""),
			),
		]);

		return {
			workDir: root,
			dir: (dir ?? "").replace(/^\/+|\/+$/g, ""),
			isRepo: git.isRepo,
			branch: git.branch,
			entries: listing.entries,
			truncated: listing.truncated,
			changes: git.changes,
		};
	});

	server.get("/sessions/:id/workspace/file", {
		schema: {
			params: Type.Object({ id: Type.String() }),
			querystring: Type.Object({ path: Type.String({ minLength: 1 }) }),
		},
	}, async (req) => {
		const { id } = req.params as { id: string };
		const { path } = req.query as { path: string };
		const root = workDirFor(id);
		const abs = safeInsideRoot(root, path);
		if (!abs) throw badRequest("invalid path");
		if (!existsSync(abs)) throw notFound("file not found");
		const st = lstatSync(abs);
		if (!st.isFile()) throw badRequest("not a regular file");
		const { buf, truncated, size } = readHeadBytes(abs, MAX_FILE_BYTES);
		if (buf.includes(0)) {
			return { path, content: "", binary: true, truncated: false, size, lineCount: 0 };
		}
		const content = buf.toString("utf-8");
		const lineCount = content ? content.split(/\r?\n/).length : 0;
		return { path, content, binary: false, truncated, size, lineCount };
	});

	server.put("/sessions/:id/workspace/file", {
		schema: {
			params: Type.Object({ id: Type.String() }),
			body: Type.Object({
				path: Type.String({ minLength: 1 }),
				content: Type.String(),
			}),
		},
	}, async (req) => {
		const { id } = req.params as { id: string };
		const { path, content } = req.body as { path: string; content: string };
		const root = workDirFor(id);
		const abs = safeInsideRoot(root, path);
		if (!abs) throw badRequest("invalid path");
		if (Buffer.byteLength(content, "utf-8") > 2 * 1024 * 1024) {
			throw badRequest("file content too large");
		}
		const st = lstatSafe(abs);
		if (st && !st.isFile()) throw badRequest("not a regular file");
		writeFileSync(abs, content, "utf-8");
		const size = Buffer.byteLength(content, "utf-8");
		const lineCount = content ? content.split(/\r?\n/).length : 0;
		return { path, size, lineCount };
	});

	server.get("/sessions/:id/workspace/diff", {
		schema: {
			params: Type.Object({ id: Type.String() }),
			querystring: Type.Object({ path: Type.String({ minLength: 1 }) }),
		},
	}, async (req) => {
		const { id } = req.params as { id: string };
		const { path } = req.query as { path: string };
		const root = workDirFor(id);
		const abs = safeInsideRoot(root, path);
		if (!abs) throw badRequest("invalid path");

		const top = await runGit(root, ["rev-parse", "--show-toplevel"]);
		if (top.code !== 0 || !top.stdout.trim()) {
			return { path, isRepo: false, hunks: [], additions: 0, deletions: 0, binary: false, truncated: false };
		}
		const repoRoot = realpathSafe(top.stdout.trim()) ?? resolve(top.stdout.trim());
		const realAbs = realpathSafe(abs) ?? abs;
		const repoRel = relative(repoRoot, realAbs).replace(/\\/g, "/");
		if (!repoRel || repoRel.startsWith("..")) throw badRequest("path outside repository");

		const statusRes = await runGit(repoRoot, ["status", "--porcelain=v1", "--", repoRel]);
		const statusLine = statusRes.stdout.trim();
		const isUntracked = statusLine.startsWith("?? ");

		if (isUntracked && existsSync(abs)) {
			const st = lstatSync(abs);
			if (!st.isFile()) {
				return { path, isRepo: true, hunks: [], additions: 0, deletions: 0, binary: false, truncated: false };
			}
			const { buf, truncated } = readHeadBytes(abs, MAX_DIFF_BYTES);
			if (buf.includes(0)) {
				return { path, isRepo: true, hunks: [], additions: 0, deletions: 0, binary: true, truncated: false };
			}
			const text = buf.toString("utf-8");
			const rows = text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
			const lines: DiffLine[] = rows.map((line, i) => ({ type: "add", oldLine: null, newLine: i + 1, text: line }));
			return {
				path,
				isRepo: true,
				hunks: lines.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, newStart: 1, lines }] : [],
				additions: lines.length,
				deletions: 0,
				binary: false,
				truncated,
			};
		}

		const hasHead = (await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"])).code === 0;
		const diffArgs = hasHead
			? ["diff", "HEAD", "--no-color", "--unified=3", "--", repoRel]
			: ["diff", "--cached", "--no-color", "--unified=3", "--", repoRel];
		const diffRes = await runGit(repoRoot, diffArgs, MAX_DIFF_BYTES);
		const parsed = parseUnifiedDiff(diffRes.stdout);
		return {
			path,
			isRepo: true,
			hunks: parsed.hunks,
			additions: parsed.additions,
			deletions: parsed.deletions,
			binary: parsed.binary,
			truncated: diffRes.truncated,
		};
	});
}
