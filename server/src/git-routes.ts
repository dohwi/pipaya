import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import Type from "typebox";
import { badRequest, notFound } from "./errors.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/**
 * Read-only git for the right sidebar: what the working directory of a session looks like right now. Nothing here writes
 * (no stage, no discard, no commit): the client only reads, and the agent does the changing.
 *
 * Every command runs on the server, in the session's own directory, because the client may be on another machine.
 */

/** A changed file of the working tree, as `git status --porcelain=v2` reports it. */
export interface GitFile {
	/** Path relative to the working directory; a rename carries its old path in `from`. */
	path: string;
	/** The old path of a rename or copy. */
	from?: string;
	/** `staged` = the index differs from HEAD, `unstaged` = the working tree differs from the index, `untracked`, `conflict`. */
	state: "staged" | "unstaged" | "untracked" | "conflict";
	/** The porcelain letter: M A D R C T U (or ? for untracked). */
	code: string;
	/** Lines added / removed (`git diff --numstat`); absent for untracked and binary files. */
	add?: number;
	del?: number;
}

/** A local or remote-tracking branch. */
export interface GitBranch {
	/** `main`, or `origin/main` for a remote-tracking one. */
	name: string;
	remote: boolean;
	/** The branch checked out in the session's own worktree. */
	current: boolean;
	/** Checked out in another worktree (it cannot be checked out twice). */
	elsewhere: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	/** The upstream branch no longer exists on the remote. */
	gone: boolean;
	/** Tip commit time, seconds since the epoch. */
	at: number;
	head: string;
}

/** What one commit changed, against its first parent (a root commit against the empty tree). */
export interface GitCommitDetail {
	hash: string;
	subject: string;
	/** The message after the subject line, trimmed. */
	body: string;
	author: string;
	email: string;
	at: number;
	parents: string[];
	files: GitCommitFile[];
	/** More files than the list cap: the list was cut. */
	truncated: boolean;
}

export interface GitCommitFile {
	path: string;
	from?: string;
	/** A M D R C T. */
	code: string;
	add?: number;
	del?: number;
}

export interface GitWorktree {
	path: string;
	/** The checked-out branch, or null when the worktree is detached. */
	branch: string | null;
	head: string | null;
	bare: boolean;
	/** The worktree this one was added from, when it is a linked one. */
	main: boolean;
}

/** One commit of the history graph (`git log --branches --tags --remotes HEAD --topo-order`; not `--all`, which would draw the stash's own commits): enough to draw lanes and a row, nothing more. */
export interface GitCommit {
	hash: string;
	/** Parent hashes, first parent first; two or more = a merge. */
	parents: string[];
	subject: string;
	author: string;
	/** Author time, seconds since the epoch. */
	at: number;
	/** Branch, tag and HEAD names pointing here (`git log %D`), e.g. `HEAD -> main`, `origin/main`, `tag: v1`. */
	refs: string[];
}

export interface GitStatus {
	/** False when the directory is not inside a git repository (or git is not installed): everything else is then empty. */
	repo: boolean;
	/** The top level of the repository, when it is one. */
	root: string | null;
	/** Why there is no repository, for the empty state ("git is not installed", "not a git repository"). */
	reason: string | null;
	branch: string | null;
	/** The commit the branch points at, or the detached HEAD. */
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	detached: boolean;
	files: GitFile[];
	/** More files than the list cap: the list was cut. */
	truncated: boolean;
	worktrees: GitWorktree[];
	/** Local branches first (current on top, then newest), then remote-tracking ones. */
	branches: GitBranch[];
	/** Entries in `git stash list`. */
	stashes: number;
	/** The newest commits of every branch, topologically ordered (children before parents). */
	commits: GitCommit[];
	/** When this reading was taken (ms). */
	at: number;
}

export interface GitDiff {
	path: string;
	staged: boolean;
	/** Unified diff text; empty when the file has no textual change (binary, or a pure mode change). */
	patch: string;
	truncated: boolean;
	binary: boolean;
}

/** Caps: a status list and a diff are for reading, not for loading a whole repository into the client. */
export const MAX_FILES = 300;
export const MAX_WORKTREES = 30;
export const MAX_COMMITS = 80;
export const MAX_BRANCHES = 100;
export const MAX_DIFF_BYTES = 200 * 1024;
export const GIT_TIMEOUT_MS = 8000;

const SessionParam = Type.Object({ id: Type.String() });
const DiffQuery = Type.Object({
	path: Type.String({ minLength: 1, description: "Relative to the working directory, as `git status` reported it" }),
	staged: Type.Optional(Type.Boolean({ description: "Diff the index against HEAD instead of the working tree against the index" })),
	commit: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{7,64}$", description: "Diff this commit against its first parent instead of the working tree" })),
});

const GitFileSchema = Type.Object({
	path: Type.String(),
	from: Type.Optional(Type.String()),
	state: Type.Union([Type.Literal("staged"), Type.Literal("unstaged"), Type.Literal("untracked"), Type.Literal("conflict")]),
	code: Type.String(),
	add: Type.Optional(Type.Integer()),
	del: Type.Optional(Type.Integer()),
});
const GitBranchSchema = Type.Object({
	name: Type.String(),
	remote: Type.Boolean(),
	current: Type.Boolean(),
	elsewhere: Type.Boolean(),
	upstream: Type.Union([Type.String(), Type.Null()]),
	ahead: Type.Integer(),
	behind: Type.Integer(),
	gone: Type.Boolean(),
	at: Type.Integer(),
	head: Type.String(),
});
const GitCommitFileSchema = Type.Object({
	path: Type.String(),
	from: Type.Optional(Type.String()),
	code: Type.String(),
	add: Type.Optional(Type.Integer()),
	del: Type.Optional(Type.Integer()),
});
export const GitCommitDetailSchema = Type.Object({
	hash: Type.String(),
	subject: Type.String(),
	body: Type.String(),
	author: Type.String(),
	email: Type.String(),
	at: Type.Integer(),
	parents: Type.Array(Type.String()),
	files: Type.Array(GitCommitFileSchema),
	truncated: Type.Boolean(),
});
const HashQuery = Type.Object({ hash: Type.String({ pattern: "^[0-9a-fA-F]{7,64}$", description: "A commit id from the graph" }) });
const GitCommitSchema = Type.Object({
	hash: Type.String(),
	parents: Type.Array(Type.String()),
	subject: Type.String(),
	author: Type.String(),
	at: Type.Integer(),
	refs: Type.Array(Type.String()),
});
const GitWorktreeSchema = Type.Object({
	path: Type.String(),
	branch: Type.Union([Type.String(), Type.Null()]),
	head: Type.Union([Type.String(), Type.Null()]),
	bare: Type.Boolean(),
	main: Type.Boolean(),
});
export const GitStatusSchema = Type.Object({
	repo: Type.Boolean(),
	root: Type.Union([Type.String(), Type.Null()]),
	reason: Type.Union([Type.String(), Type.Null()]),
	branch: Type.Union([Type.String(), Type.Null()]),
	head: Type.Union([Type.String(), Type.Null()]),
	upstream: Type.Union([Type.String(), Type.Null()]),
	ahead: Type.Integer(),
	behind: Type.Integer(),
	detached: Type.Boolean(),
	files: Type.Array(GitFileSchema),
	truncated: Type.Boolean(),
	worktrees: Type.Array(GitWorktreeSchema),
	branches: Type.Array(GitBranchSchema),
	stashes: Type.Integer(),
	commits: Type.Array(GitCommitSchema),
	at: Type.Integer(),
});
export const GitDiffSchema = Type.Object({
	path: Type.String(),
	staged: Type.Boolean(),
	patch: Type.String(),
	truncated: Type.Boolean(),
	binary: Type.Boolean(),
});

interface Run { code: number; out: string; err: string }

/**
 * One git command, with a timeout and no terminal prompt (a credential prompt would hang the request). `-c` settings keep
 * the output stable whatever the user's own git config says (colour, pager, quoting of non-ASCII paths).
 */
async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<Run> {
	const proc = Bun.spawn(
		["git", "-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.pager=cat", ...args],
		{ cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
	);
	// A hung git (a network filesystem, a lock held by another process) must not hold the request open.
	const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, timeoutMs);
	try {
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { code: await proc.exited, out, err };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `git status --porcelain=v2 -b -z`, parsed. NUL-separated because a path may hold a newline; a rename's second record is
 * the old path. Only the branch header and the entries are read: submodule and ignored records are skipped.
 */
export function parseStatus(raw: string): Pick<GitStatus, "branch" | "head" | "upstream" | "ahead" | "behind" | "detached" | "files" | "truncated"> {
	const out: Pick<GitStatus, "branch" | "head" | "upstream" | "ahead" | "behind" | "detached" | "files" | "truncated"> = {
		branch: null, head: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [], truncated: false,
	};
	const records = raw.split("\0");
	for (let i = 0; i < records.length; i++) {
		const rec = records[i]!;
		if (!rec) continue;
		if (rec.startsWith("# ")) {
			const [key, ...rest] = rec.slice(2).split(" ");
			const value = rest.join(" ");
			if (key === "branch.oid") out.head = value === "(initial)" ? null : value;
			else if (key === "branch.head") {
				if (value === "(detached)") out.detached = true;
				else out.branch = value;
			} else if (key === "branch.upstream") out.upstream = value;
			else if (key === "branch.ab") {
				const m = /^\+(\d+) -(\d+)$/.exec(value);
				if (m) {
					out.ahead = Number(m[1]);
					out.behind = Number(m[2]);
				}
			}
			continue;
		}
		if (out.files.length >= MAX_FILES) {
			out.truncated = true;
			continue;
		}
		const kind = rec[0];
		if (kind === "1" || kind === "2") {
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>   (the old path is the next record)
			const parts = rec.split(" ");
			const xy = parts[1] ?? "..";
			const rest = parts.slice(8).join(" ");
			const path = kind === "2" ? rest.split(" ").slice(1).join(" ") : rest;
			const from = kind === "2" ? records[++i] : undefined;
			const entry: GitFile = { path, state: "unstaged", code: xy[1] ?? "." };
			if (xy[0] !== ".") {
				// staged: the index differs from HEAD, which is what the user sees as "to be committed"
				entry.state = "staged";
				entry.code = xy[0]!;
			}
			if (xy[0] === "U" || xy[1] === "U" || xy === "AA" || xy === "DD") {
				entry.state = "conflict";
				entry.code = "U";
			}
			if (from) entry.from = from;
			out.files.push(entry);
			continue;
		}
		if (kind === "u") {
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>: an unmerged (conflicted) entry
			const parts = rec.split(" ");
			out.files.push({ path: parts.slice(10).join(" "), state: "conflict", code: "U" });
			continue;
		}
		if (kind === "?") out.files.push({ path: rec.slice(2), state: "untracked", code: "?" });
	}
	// staged first, then unstaged, then untracked: the order the panel reads in
	const rank = { conflict: 0, staged: 1, unstaged: 2, untracked: 3 } as const;
	out.files.sort((a, b) => rank[a.state] - rank[b.state] || a.path.localeCompare(b.path));
	return out;
}

/** `git worktree list --porcelain`: blank-line separated blocks of `key value` lines. */
export function parseWorktrees(raw: string): GitWorktree[] {
	const out: GitWorktree[] = [];
	for (const block of raw.split(/\n\s*\n/)) {
		let path: string | null = null;
		let head: string | null = null;
		let branch: string | null = null;
		let bare = false;
		for (const line of block.split("\n")) {
			if (!line.trim()) continue;
			const at = line.indexOf(" ");
			const key = at < 0 ? line : line.slice(0, at);
			const value = at < 0 ? "" : line.slice(at + 1);
			if (key === "worktree") path = value;
			else if (key === "HEAD") head = value;
			else if (key === "branch") branch = value.replace(/^refs\/heads\//, "");
			else if (key === "bare") bare = true;
		}
		if (path) out.push({ path, branch, head, bare, main: false });
	}
	// the first block is the main worktree; the rest were added from it
	if (out.length) out[0]!.main = true;
	return out;
}

/** Field and record separators of the `git log` format below: control characters a subject cannot contain. */
const FS = "\x1f";
const RS = "\x1e";
export const LOG_FORMAT = ["%H", "%P", "%an", "%at", "%D", "%s"].join(FS) + RS;

/** `git log --format=LOG_FORMAT`, parsed. */
export function parseLog(raw: string): GitCommit[] {
	const out: GitCommit[] = [];
	for (const rec of raw.split(RS)) {
		const f = rec.replace(/^\n/, "").split(FS);
		if (f.length < 6 || !f[0]) continue;
		out.push({
			hash: f[0],
			parents: f[1] ? f[1].split(" ") : [],
			author: f[2]!,
			at: Number(f[3]) || 0,
			refs: f[4] ? f[4].split(", ").filter(Boolean) : [],
			subject: f.slice(5).join(FS),
		});
	}
	return out;
}

/**
 * `git for-each-ref` over heads and remotes, one line per ref, fields split by 0x1f. `current` is the branch of `root`
 * itself; a branch another worktree has checked out is `elsewhere` (git refuses to check it out twice).
 */
export const BRANCH_FORMAT = ["%(refname)", "%(refname:short)", "%(HEAD)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(committerdate:unix)", "%(objectname)", "%(worktreepath)"].join(FS);

export function parseBranches(raw: string): GitBranch[] {
	const out: GitBranch[] = [];
	for (const line of raw.split("\n")) {
		const f = line.split(FS);
		if (f.length < 8) continue;
		const [ref, short, mark, upstream, track, at, head, tree] = f as [string, string, string, string, string, string, string, string];
		// `origin/HEAD` is a pointer, not a branch of its own
		if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) continue;
		const remote = ref.startsWith("refs/remotes/");
		out.push({
			name: short,
			remote,
			current: mark === "*",
			elsewhere: !remote && mark !== "*" && tree !== "",
			upstream: upstream || null,
			ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
			behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
			gone: track === "gone",
			at: Number(at) || 0,
			head,
		});
	}
	// local before remote, the current one first, then the most recently committed to
	out.sort((a, b) => Number(a.remote) - Number(b.remote) || Number(b.current) - Number(a.current) || b.at - a.at || a.name.localeCompare(b.name));
	return out.slice(0, MAX_BRANCHES);
}

/**
 * `git diff --numstat -z`: `add\tdel\tpath\0`, and for a rename `add\tdel\t\0old\0new\0`. Binary files report `-`
 * for both counts and are left out (no number is better than a wrong one). Keyed by the new path.
 */
export function parseNumstat(raw: string): Map<string, { add: number; del: number }> {
	const out = new Map<string, { add: number; del: number }>();
	const parts = raw.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i]!;
		if (!rec) continue;
		const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
		if (!m) continue;
		let path = m[3]!;
		if (path === "") {
			i += 2; // a rename: the next two records are the old and the new path
			path = parts[i] ?? "";
		}
		if (m[1] !== "-" && m[2] !== "-") out.set(path, { add: Number(m[1]), del: Number(m[2]) });
	}
	return out;
}

/** `git show --name-status -z`: `X\0path\0`, and `R100\0old\0new\0` for a rename or copy. */
export function parseNameStatus(raw: string): GitCommitFile[] {
	const out: GitCommitFile[] = [];
	const parts = raw.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i];
		if (!code) continue;
		const letter = code[0]!;
		if (letter === "R" || letter === "C") {
			const from = parts[++i] ?? "";
			const path = parts[++i] ?? "";
			out.push({ path, from, code: letter });
		} else {
			out.push({ path: parts[++i] ?? "", code: letter });
		}
	}
	return out.filter((f) => f.path);
}

/** Whether `dir` is a directory at all: a session may point at a folder that has since been deleted. */
async function isDir(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

export function registerGitRoutes(server: FastifyInstance, cwdOf: (sessionId: string) => string | undefined): void {
	const app = server.withTypeProvider<TypeBoxProvider>();

	app.get("/sessions/:id/git", {
		schema: { params: SessionParam, response: { 200: GitStatusSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = cwdOf(req.params.id);
			if (!cwd) throw notFound("session");
			const empty = (reason: string): GitStatus => ({
				repo: false, root: null, reason, branch: null, head: null, upstream: null, ahead: 0, behind: 0, detached: false,
				files: [], truncated: false, worktrees: [], branches: [], stashes: 0, commits: [], at: Date.now(),
			});
			if (!(await isDir(cwd))) return empty("missing");
			const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
			if (top.code !== 0) {
				// git missing (127) is not the same as "not a repository": the panel says which
				return empty(top.err.includes("not a git repository") ? "not-a-repo" : "no-git");
			}
			const root = top.out.trim();
			const status = await git(root, ["status", "--porcelain=v2", "-b", "-z"]);
			if (status.code !== 0) return empty("no-git");
			const trees = await git(root, ["worktree", "list", "--porcelain"]);
			const parsed = parseStatus(status.out);
			// line counts for the listed files: the index against HEAD, and the working tree against the index
			const [cachedStat, workStat, refs, stash] = await Promise.all([
				git(root, ["diff", "--numstat", "-z", "--cached"]),
				git(root, ["diff", "--numstat", "-z"]),
				git(root, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"]),
				git(root, ["stash", "list"]),
			]);
			const cached = parseNumstat(cachedStat.out);
			const work = parseNumstat(workStat.out);
			for (const f of parsed.files) {
				const n = (f.state === "staged" ? cached : work).get(f.path);
				if (n) {
					f.add = n.add;
					f.del = n.del;
				}
			}
			// a repository with no commit yet has no log: that is an empty graph, not an error
			const log = await git(root, ["log", "--branches", "--tags", "--remotes", "HEAD", "--topo-order", `--max-count=${MAX_COMMITS}`, `--format=${LOG_FORMAT}`]);
			return {
				repo: true,
				root,
				reason: null,
				...parsed,
				worktrees: trees.code === 0 ? parseWorktrees(trees.out).slice(0, MAX_WORKTREES) : [],
				branches: refs.code === 0 ? parseBranches(refs.out) : [],
				stashes: stash.code === 0 ? stash.out.split("\n").filter(Boolean).length : 0,
				commits: log.code === 0 ? parseLog(log.out) : [],
				at: Date.now(),
			};
		},
	});

	app.get("/sessions/:id/git/commit", {
		schema: { params: SessionParam, querystring: HashQuery, response: { 200: GitCommitDetailSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = cwdOf(req.params.id);
			if (!cwd) throw notFound("session");
			const hash = req.query.hash;
			const meta = await git(cwd, ["show", "--no-patch", "-s", `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%s${FS}%b`, hash]);
			if (meta.code !== 0) throw notFound("commit");
			const [full, parents, author, email, at, subject, ...body] = meta.out.replace(/\n$/, "").split(FS) as string[];
			// against the first parent, so a merge lists what it brought in; `--root` makes the first commit list everything
			const names = await git(cwd, ["show", "--first-parent", "-m", "--format=", "--name-status", "-z", "--find-renames", "--root", hash]);
			const stats = await git(cwd, ["show", "--first-parent", "-m", "--format=", "--numstat", "-z", "--find-renames", "--root", hash]);
			const num = parseNumstat(stats.out);
			const all = parseNameStatus(names.out);
			const files = all.slice(0, MAX_FILES).map((f) => {
				const n = num.get(f.path);
				return n ? { ...f, add: n.add, del: n.del } : f;
			});
			return {
				hash: full!,
				subject: subject ?? "",
				body: body.join(FS).trim(),
				author: author ?? "",
				email: email ?? "",
				at: Number(at) || 0,
				parents: parents ? parents.split(" ") : [],
				files,
				truncated: all.length > MAX_FILES,
			};
		},
	});

	app.get("/sessions/:id/git/diff", {
		schema: { params: SessionParam, querystring: DiffQuery, response: { 200: GitDiffSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = cwdOf(req.params.id);
			if (!cwd) throw notFound("session");
			const path = req.query.path;
			// a path from the status list only: no absolute paths, no walking out of the repository
			if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) throw badRequest("path must be inside the working directory");
			const staged = req.query.staged ?? false;
			const commit = req.query.commit;
			if (commit) {
				const shown = await git(cwd, ["show", "--first-parent", "-m", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", commit, "--", path]);
				let patch = shown.code === 0 ? shown.out : "";
				const truncated = patch.length > MAX_DIFF_BYTES;
				if (truncated) patch = patch.slice(0, MAX_DIFF_BYTES);
				return { path, staged: false, patch, truncated, binary: /^Binary files |^GIT binary patch/m.test(patch) };
			}
			const run = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", path]);
			let patch = run.out;
			// an untracked file has no diff: show its content as an addition, so a click on it still says something
			if (!patch.trim() && !staged) patch = (await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path])).out;
			const truncated = patch.length > MAX_DIFF_BYTES;
			if (truncated) patch = patch.slice(0, MAX_DIFF_BYTES);
			return { path, staged, patch, truncated, binary: /^Binary files |^GIT binary patch/m.test(patch) };
		},
	});
}
