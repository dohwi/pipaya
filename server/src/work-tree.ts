/**
 * Which working tree a session's agent works in now. A session keeps the cwd it was made with (its tools, relative paths
 * and AGENTS.md are bound to it), but an agent that makes a git worktree and goes on there (`cd ../app-x && …`, edits under
 * it) works on another branch: the session's `activeDir` follows it so the sidebar lists it under that worktree.
 * Only another working tree of the session's own repository counts; anything else leaves `activeDir` as it is.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { repoOf } from "./git-info.ts";

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, "$2");

/**
 * The folder a shell command ends up in after its `cd`s, each resolved against the one before (a bash call starts in
 * `cwd`). Null when the command never changes folder or does so in a way that cannot be read (`cd -`, a variable).
 * A `cd` in a subshell (`(cd x && …)`) does not count: it is undone when the parenthesis closes.
 */
export function cdTarget(command: string, cwd: string, home = homedir()): string | null {
	let dir = cwd;
	let moved = false;
	for (const raw of command.split(/&&|\|\||[;\n|]/)) {
		const m = /^\s*(?:cd|pushd)(?:\s+(\S+))?\s*$/.exec(raw);
		if (!m) continue;
		const arg = unquote(m[1] ?? "~");
		if (arg === "-" || arg.includes("$") || arg.includes("`")) return null;
		const path = arg === "~" ? home : arg.startsWith("~/") ? resolve(home, arg.slice(2)) : arg;
		dir = isAbsolute(path) ? resolve(path) : resolve(dir, path);
		moved = true;
	}
	return moved ? dir : null;
}

/** The folder a tool call shows the agent working in, or null when the call says nothing about it. */
export function touchedDir(tool: string, args: unknown, cwd: string, home = homedir()): string | null {
	const a = (args ?? {}) as { command?: unknown; path?: unknown };
	if (tool === "bash" && typeof a.command === "string") return cdTarget(a.command, cwd, home);
	if ((tool === "edit" || tool === "write") && typeof a.path === "string" && a.path) return dirname(isAbsolute(a.path) ? resolve(a.path) : resolve(cwd, a.path));
	return null;
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
