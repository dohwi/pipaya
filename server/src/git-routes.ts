import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import Type from "typebox";
import { badRequest, notFound } from "./errors.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/**
 * Read-only git summary for the right sidebar: how big the working directory's changes are (counts, not a file list), the
 * branches, and the history graph. Nothing here writes (no stage, no discard, no commit): the client only reads, and the
 * agent does the changing.
 *
 * Every command runs on the server, in the session's own directory, because the client may be on another machine. The
 * answer's size never depends on the size of the repository: counts are numbers, lists are capped.
 */

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

/** How many files changed, by kind. Every changed file is counted once: a file staged and edited again counts as staged. */
export interface GitCounts {
	conflict: number;
	staged: number;
	unstaged: number;
	untracked: number;
}

/** Lines added / removed over every changed tracked file, binary ones left out (the sums of `git diff --numstat`). */
export interface GitLines {
	add: number;
	del: number;
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
	/** Changed files by kind; null when `git status` itself timed out (a repository too big to count in time). */
	counts: GitCounts | null;
	/** Changed lines; null when they were skipped (too many changed files, or git needed too long): the panel says so. */
	lines: GitLines | null;
	worktrees: GitWorktree[];
	/** Local branches first (current on top, then newest), then remote-tracking ones. */
	branches: GitBranch[];
	/** Entries in `git stash list`. */
	stashes: number;
	/** More branches than the picker's cap: the list was cut. */
	branchesCut: boolean;
	/** When this reading was taken (ms). */
	at: number;
}

/**
 * Caps and time limits: the panel is for a glance, not for loading a whole repository into the client. The client
 * mirrors the commit numbers (client/src/lib/git-limits.ts); a test keeps the two equal.
 */
export const GIT_LIMITS = {
	/** Branches offered in the picker, local ones first (`branchesCut` says the rest was cut). */
	branches: 60,
	worktrees: 20,
	/** Commits per page of the graph, and the most a client can ask for in total. */
	commitsPage: 50,
	commitsMax: 300,
	/** Any one git command. */
	timeoutMs: 8000,
	/**
	 * Changed lines need a real diff of every changed file, which costs time in proportion to their size (a 20,000-file
	 * change took 5 s). Past this many changed tracked files the sums are skipped, and a diff that is still running after
	 * `linesTimeoutMs` is dropped: no number beats a panel that waits.
	 */
	linesMaxFiles: 5000,
	linesTimeoutMs: 3000,
} as const;
export const MAX_WORKTREES = GIT_LIMITS.worktrees;
export const MAX_BRANCHES = GIT_LIMITS.branches;
export const GIT_TIMEOUT_MS = GIT_LIMITS.timeoutMs;

const SessionParam = Type.Object({ id: Type.String() });

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
const GitCountsSchema = Type.Object({ conflict: Type.Integer(), staged: Type.Integer(), unstaged: Type.Integer(), untracked: Type.Integer() });
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
	counts: Type.Union([GitCountsSchema, Type.Null()]),
	lines: Type.Union([Type.Object({ add: Type.Integer(), del: Type.Integer() }), Type.Null()]),
	worktrees: Type.Array(GitWorktreeSchema),
	branches: Type.Array(GitBranchSchema),
	stashes: Type.Integer(),
	branchesCut: Type.Boolean(),
	at: Type.Integer(),
});
export const GitLogSchema = Type.Object({
	commits: Type.Array(GitCommitSchema),
	/** Older commits exist beyond this page. */
	more: Type.Boolean(),
});
const LogQuery = Type.Object({
	ref: Type.Optional(Type.String({ maxLength: 300, description: "A full ref name from the branch list (`refs/heads/x`, `refs/remotes/origin/x`); left out = every branch and tag" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: GIT_LIMITS.commitsMax, description: "How many commits, newest first (default one page)" })),
});

interface Run {
	code: number;
	out: string;
	err: string;
	/** The command was killed for running past its time limit. */
	timedOut: boolean;
}

/**
 * Identical git reads that overlap share one process: a refresh that lands while the last one still runs (a turn ending
 * while the user presses reload, two windows on one folder) must not start the same `git status` again. Only the
 * in-flight call is shared, never a finished result, so nothing is ever stale.
 */
const inflight = new Map<string, Promise<unknown>>();
export function once<T>(key: string, work: () => Promise<T>): Promise<T> {
	const hit = inflight.get(key);
	if (hit) return hit as Promise<T>;
	const p = work().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/**
 * One git command, with a timeout and no terminal prompt (a credential prompt would hang the request). `-c` settings keep
 * the output stable whatever the user's own git config says (colour, pager, quoting of non-ASCII paths).
 */
async function git(cwd: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<Run> {
	const proc = Bun.spawn(
		["git", "-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.pager=cat", ...args],
		{ cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
	);
	// A hung git (a network filesystem, a lock held by another process) must not hold the request open.
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { proc.kill(); } catch { /* already gone */ }
	}, timeoutMs);
	try {
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { code: await proc.exited, out, err, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

type Parsed = Pick<GitStatus, "branch" | "head" | "upstream" | "ahead" | "behind" | "detached"> & { counts: GitCounts };

/**
 * `git status --porcelain=v2 -b -z`, counted. NUL-separated because a path may hold a newline; a rename's second record
 * is the old path and is skipped. Only the branch header and the kind of every entry are read: no path is kept, so a
 * hundred thousand changed files cost a loop, not a hundred thousand objects.
 */
export function parseStatus(raw: string): Parsed {
	const out: Parsed = {
		branch: null, head: null, upstream: null, ahead: 0, behind: 0, detached: false,
		counts: { conflict: 0, staged: 0, unstaged: 0, untracked: 0 },
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
		const kind = rec[0];
		if (kind === "1" || kind === "2") {
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>   (the old path is the next record)
			const xy = rec.slice(2, 4);
			if (kind === "2") i++;
			if (xy[0] === "U" || xy[1] === "U" || xy === "AA" || xy === "DD") out.counts.conflict++;
			// staged: the index differs from HEAD, which is what the user sees as "to be committed"
			else if (xy[0] !== ".") out.counts.staged++;
			else out.counts.unstaged++;
		} else if (kind === "u") out.counts.conflict++; // an unmerged (conflicted) entry
		else if (kind === "?") out.counts.untracked++;
	}
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
	return out;
}

/** The branch list as the panel shows it: capped, and whether anything was cut. */
export function capBranches(all: GitBranch[]): { branches: GitBranch[]; cut: boolean } {
	return { branches: all.slice(0, MAX_BRANCHES), cut: all.length > MAX_BRANCHES };
}

/**
 * `git diff --numstat -z`: `add\tdel\tpath\0`, and for a rename `add\tdel\t\0old\0new\0`, summed. Binary files report `-`
 * for both counts and are left out (no number is better than a wrong one).
 */
export function sumNumstat(raw: string): GitLines {
	const sum: GitLines = { add: 0, del: 0 };
	const parts = raw.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const rec = parts[i]!;
		if (!rec) continue;
		const m = /^(\d+|-)\t(\d+|-)\t/.exec(rec);
		if (!m) continue;
		// a rename: the path is empty here and the next two records are the old and the new path
		if (rec.length === m[0].length) i += 2;
		if (m[1] !== "-" && m[2] !== "-") (sum.add += Number(m[1])), (sum.del += Number(m[2]));
	}
	return sum;
}

/** Whether `dir` is a directory at all: a session may point at a folder that has since been deleted. */
async function isDir(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

const NO_COUNTS: GitCounts = { conflict: 0, staged: 0, unstaged: 0, untracked: 0 };

/**
 * Changed lines of the tracked files (the index against HEAD plus the working tree against the index), or null when it
 * would cost too much: too many changed files, or git still running at the time limit.
 */
async function readLines(root: string, tracked: number): Promise<GitLines | null> {
	if (tracked === 0) return { add: 0, del: 0 };
	if (tracked > GIT_LIMITS.linesMaxFiles) return null;
	const args = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"];
	const [cached, work] = await Promise.all([
		git(root, [...args, "--cached"], GIT_LIMITS.linesTimeoutMs),
		git(root, args, GIT_LIMITS.linesTimeoutMs),
	]);
	if (cached.timedOut || work.timedOut || cached.code !== 0 || work.code !== 0) return null;
	const a = sumNumstat(cached.out);
	const b = sumNumstat(work.out);
	return { add: a.add + b.add, del: a.del + b.del };
}

async function readStatus(cwd: string): Promise<GitStatus> {
	const empty = (reason: string): GitStatus => ({
		repo: false, root: null, reason, branch: null, head: null, upstream: null, ahead: 0, behind: 0, detached: false,
		counts: NO_COUNTS, lines: null, worktrees: [], branches: [], branchesCut: false, stashes: 0, at: Date.now(),
	});
	if (!(await isDir(cwd))) return empty("missing");
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) {
		// git missing (127) is not the same as "not a repository": the panel says which
		return empty(top.err.includes("not a git repository") ? "not-a-repo" : "no-git");
	}
	const root = top.out.trim();
	// `-uall` counts an untracked folder by its files (a bare `new/` would count as one)
	const [status, trees, refs, stash] = await Promise.all([
		git(root, ["status", "--porcelain=v2", "-b", "-z", "--untracked-files=all"]),
		git(root, ["worktree", "list", "--porcelain"]),
		git(root, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"]),
		git(root, ["stash", "list"]),
	]);
	// a repository too big for `git status` to answer in time is still a repository: the branches and the graph work
	if (status.code !== 0 && !status.timedOut) return empty("no-git");
	const parsed = status.timedOut ? null : parseStatus(status.out);
	const counts = parsed?.counts ?? null;
	const lines = counts ? await readLines(root, counts.staged + counts.unstaged + counts.conflict) : null;
	const { branches, cut } = capBranches(refs.code === 0 ? parseBranches(refs.out) : []);
	return {
		repo: true,
		root,
		reason: null,
		// when status timed out the current branch is still known from the branch list
		branch: parsed?.branch ?? branches.find((b) => b.current)?.name ?? null,
		head: parsed?.head ?? null,
		upstream: parsed?.upstream ?? null,
		ahead: parsed?.ahead ?? 0,
		behind: parsed?.behind ?? 0,
		detached: parsed?.detached ?? false,
		counts,
		lines,
		worktrees: trees.code === 0 ? parseWorktrees(trees.out).slice(0, MAX_WORKTREES) : [],
		branches,
		branchesCut: cut,
		stashes: stash.code === 0 ? stash.out.split("\n").filter(Boolean).length : 0,
		at: Date.now(),
	};
}

export function registerGitRoutes(server: FastifyInstance, cwdOf: (sessionId: string) => string | undefined): void {
	const app = server.withTypeProvider<TypeBoxProvider>();

	app.get("/sessions/:id/git", {
		schema: { params: SessionParam, response: { 200: GitStatusSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = cwdOf(req.params.id);
			if (!cwd) throw notFound("session");
			// two readers of one folder (or a refresh on top of a refresh) share the one set of git processes
			return once(`status\0${cwd}`, () => readStatus(cwd));
		},
	});

	app.get("/sessions/:id/git/log", {
		schema: { params: SessionParam, querystring: LogQuery, response: { 200: GitLogSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = cwdOf(req.params.id);
			if (!cwd) throw notFound("session");
			const limit = req.query.limit ?? GIT_LIMITS.commitsPage;
			const ref = req.query.ref;
			let roots: string[] = ["--branches", "--tags", "--remotes", "HEAD"];
			if (ref) {
				// only a branch the picker offered: never an option, a range or a revision expression
				if (!/^refs\/(heads|remotes)\/[^\s~^:?*\[\\]+$/.test(ref) || ref.includes("..") || ref.includes("@{")) throw badRequest("ref must be a branch name from the branch list");
				const ok = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
				if (ok.code !== 0) throw notFound("branch");
				roots = [ref];
			}
			// one more than asked, to know whether there is a next page; an empty repository has no log (not an error)
			const log = await git(cwd, ["log", "--topo-order", `--max-count=${limit + 1}`, `--format=${LOG_FORMAT}`, ...roots, "--"]);
			const commits = log.code === 0 ? parseLog(log.out) : [];
			return { commits: commits.slice(0, limit), more: commits.length > limit };
		},
	});
}
