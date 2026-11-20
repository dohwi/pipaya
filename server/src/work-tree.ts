/**
 * Which working tree a session's agent works in now. An agent that makes a git worktree of its session's repository
 * (`git worktree add ../app-x`), goes there (`cd ../app-x && …`) or edits under it works on another branch: the session's
 * `activeDir` follows it. Its tools then start there (bash runs there, relative paths resolve against it), the agent is
 * told so, and the sidebar lists the session under that worktree. AGENTS.md, skills and the session's `cwd` stay as made.
 * Only another working tree of the session's own repository counts; anything else leaves `activeDir` as it is.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { repoOf } from "./git-info.ts";

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, "$2");

/** Options of `git worktree add` that take a value: the path is the first word that is neither one nor its value. */
const ADD_VALUE_OPTIONS = new Set(["-b", "-B", "--reason"]);

/** The path `git [-C dir] worktree add [opts] <path> …` creates, against `dir`; null when the words are not that command. */
function worktreeAddPath(words: string[], dir: string, home: string): string | null {
	if (words[0] !== "git") return null;
	let i = 1;
	let base = dir;
	while (words[i] === "-C" && words[i + 1]) { base = absolute(unquote(words[i + 1]!), base, home); i += 2; }
	if (words[i] !== "worktree" || words[i + 1] !== "add") return null;
	for (i += 2; i < words.length; i++) {
		const w = words[i]!;
		if (ADD_VALUE_OPTIONS.has(w)) { i++; continue; }
		if (w.startsWith("-")) continue;
		const path = unquote(w);
		return path.includes("$") || path.includes("`") ? null : absolute(path, base, home);
	}
	return null;
}

const absolute = (p: string, base: string, home: string) => {
	const path = p === "~" ? home : p.startsWith("~/") ? resolve(home, p.slice(2)) : p;
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
};

/**
 * The folder a shell command leaves its agent in: after its `cd`s, each resolved against the one before (a bash call
 * starts in `cwd`), or in a git worktree it just made (`git worktree add ../app-x`: making one is how work on it starts).
 * Null when the command does neither, or moves in a way that cannot be read (`cd -`, a variable). A `cd` in a subshell
 * (`(cd x && …)`) does not count: it is undone when the parenthesis closes.
 */
export function cdTarget(command: string, cwd: string, home = homedir()): string | null {
	let dir = cwd;
	let target: string | null = null;
	for (const raw of command.split(/&&|\|\||[;\n|]/)) {
		const words = raw.trim().split(/\s+/).filter(Boolean);
		if (words[0] === "cd" || words[0] === "pushd") {
			if (words.length > 2) continue;
			const arg = unquote(words[1] ?? "~");
			if (arg === "-" || arg.includes("$") || arg.includes("`")) return null;
			target = dir = absolute(arg, dir, home);
			continue;
		}
		const made = worktreeAddPath(words, dir, home);
		if (made) target = made;
	}
	return target;
}

/** The folder a tool call shows the agent working in, or null when the call says nothing about it. */
export function touchedDir(tool: string, args: unknown, cwd: string, home = homedir()): string | null {
	const a = (args ?? {}) as { command?: unknown; path?: unknown };
	if (tool === "bash" && typeof a.command === "string") return cdTarget(a.command, cwd, home);
	if ((tool === "edit" || tool === "write") && typeof a.path === "string" && a.path) return dirname(isAbsolute(a.path) ? resolve(a.path) : resolve(cwd, a.path));
	return null;
}

/** Where a session's agent works: the worktree it moved into, else the folder it was made in. */
export const workDirOf = (r: { cwd: string; activeDir?: string | null }): string => r.activeDir || r.cwd;

/** What the agent is told when its working folder changes, appended to the tool result that moved it. */
export function movedNote(cwd: string, from: string, to: string | null): string {
	const here = to ?? cwd;
	const branch = repoOf(here)?.branch;
	const where = `${here}${branch ? ` (branch ${branch})` : ""}`;
	if (!to && !existsSync(from)) return `[pipaya] ${from} is gone, so this session works in ${where} again: later tool calls start there.`;
	if (!to) return `[pipaya] This session works in ${where} again: later bash, read, edit and write calls start there and relative paths resolve against it.`;
	return `[pipaya] This session now works in the git worktree ${where}: later bash, read, edit and write calls start there and relative paths resolve against it. Your session's own folder is ${cwd}; \`cd ${cwd}\` goes back to it.`;
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * The session's next `activeDir`: the top of another worktree of its repository it moved into, null when it is back in
 * its own (or the worktree it was in is gone), else `current` unchanged. `allowed` rejects folders outside the workspace.
 */
export function nextActiveDir(cwd: string, current: string | null, touched: string | null, allowed: (dir: string) => boolean = () => true): string | null {
	let next = current && existsSync(current) ? current : null;
	if (!touched) return next;
	// a file written in a folder that does not exist yet still names its working tree: look from the nearest one up
	let dir = touched;
	while (!isDir(dir) && dirname(dir) !== dir) dir = dirname(dir);
	const own = repoOf(cwd);
	const there = repoOf(dir);
	if (!own || !there || there.root !== own.root) return next;
	if (there.top === own.top) next = null;
	else if (allowed(there.top)) next = there.top;
	return next;
}
