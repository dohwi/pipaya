/**
 * Which working tree a session works in. A session is made in one folder (`cwd`); its agent (the `workdir` tool) or the
 * user (moving it in the sidebar) can move it into another working tree of the same git repository, usually a worktree
 * made for one task. The session's `activeDir` then names it: its tools start there (bash runs there, relative paths
 * resolve against it) and the sidebar lists the session under it. AGENTS.md, skills and `cwd` itself stay as made.
 * Nothing moves on its own: a tool call that works in another worktree only earns a hint. The one exception is a
 * worktree that is gone, which sends the session home.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { repoOf, worktreesOf } from "./git-info.ts";

const absolute = (p: string, base: string, home: string) => {
	const path = p === "~" ? home : p.startsWith("~/") ? resolve(home, p.slice(2)) : p;
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
};

/** Quote- and subshell-aware splitter for top-level command separators (`&&`, `||`, `;`, `\n`, `|`). */
function splitShellCommands(command: string): string[] {
	const out: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let parenDepth = 0;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < command.length) { i++; continue; }
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) { i++; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "(") { parenDepth++; continue; }
		if (ch === ")") { if (parenDepth > 0) parenDepth--; continue; }
		if (parenDepth > 0) continue;

		if (ch === ";" || ch === "\n") {
			out.push(command.slice(start, i));
			start = i + 1;
		} else if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
			out.push(command.slice(start, i));
			i++;
			start = i + 1;
		} else if (ch === "|") {
			out.push(command.slice(start, i));
			start = i + 1;
		}
	}
	out.push(command.slice(start));
	return out;
}

/** Quote-aware shell word tokenizer returning `{ value, singleQuoted }`. */
function tokenizeWords(raw: string): { value: string; singleQuoted: boolean }[] {
	const words: { value: string; singleQuoted: boolean }[] = [];
	let cur = "";
	let hasWord = false;
	let singleQuoted = true;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else cur += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < raw.length) { cur += raw[++i]!; continue; }
			if (ch === '"') quote = null;
			else cur += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (hasWord) {
				words.push({ value: cur, singleQuoted });
				cur = "";
				hasWord = false;
				singleQuoted = true;
			}
			continue;
		}
		hasWord = true;
		if (ch === "'") { quote = "'"; continue; }
		if (ch === '"') { quote = '"'; singleQuoted = false; continue; }
		singleQuoted = false;
		if (ch === "\\" && i + 1 < raw.length) { cur += raw[++i]!; continue; }
		cur += ch;
	}
	if (hasWord) words.push({ value: cur, singleQuoted });
	return words;
}

/**
 * The folder a shell command ends up in after its `cd`s, each resolved against the one before (a bash call starts in
 * `cwd`). Null when it never changes folder or does so in a way that cannot be read (`cd -`, a variable). A `cd` in a
 * subshell (`(cd x && …)`) does not count: it is undone when the parenthesis closes.
 */
export function cdTarget(command: string, cwd: string, home = homedir()): string | null {
	let dir = cwd;
	let moved = false;
	for (const raw of splitShellCommands(command)) {
		const words = tokenizeWords(raw);
		if (!words.length || (words[0]!.value !== "cd" && words[0]!.value !== "pushd") || words.length > 2) continue;
		const argWord = words[1];
		const arg = argWord ? argWord.value : "~";
		if (arg === "-" || (!argWord?.singleQuoted && (arg.includes("$") || arg.includes("`")))) return null;
		dir = absolute(arg, dir, home);
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

/** Where a session works: the working tree it was moved into, else the folder it was made in. */
export const workDirOf = (r: { cwd: string; activeDir?: string | null }): string => r.activeDir || r.cwd;

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** A working tree a session made in `cwd` may move to: one of its repository's, with the branch checked out there. */
export interface WorkTarget {
	path: string;
	branch: string | null;
	/** The working tree holding `cwd` itself: moving there is going home */
	home: boolean;
}

/** The working trees a session made in `cwd` may move to (its repository's main checkout and worktrees), home first. */
export function workTargets(cwd: string, allowed: (dir: string) => boolean = () => true): WorkTarget[] {
	const own = repoOf(cwd);
	if (!own) return [];
	return worktreesOf(own.root)
		.filter((w) => w.path === own.top || allowed(w.path))
		.map((w) => ({ path: w.path, branch: w.branch, home: real(w.path) === real(own.top) }))
		.sort((a, b) => Number(b.home) - Number(a.home));
}

/**
 * Checks a move of a session made in `cwd` to `target` and says what `activeDir` becomes: null for its own working tree,
 * else the top of the other one. Throws a message fit for the agent or the user when the move is not allowed.
 */
export function resolveMove(cwd: string, target: string, allowed: (dir: string) => boolean = () => true): string | null {
	const own = repoOf(cwd);
	if (!own) throw new Error(`this session's folder ${cwd} is not in a git repository, so it has no other working tree to move to`);
	if (!isDir(target)) throw new Error(`${target} is not a folder`);
	const there = repoOf(target);
	if (!there || real(there.root) !== real(own.root)) {
		const list = workTargets(cwd, allowed).map((w) => `${w.path}${w.branch ? ` (${w.branch})` : ""}`).join(", ");
		throw new Error(`${target} is not a working tree of this session's repository (${own.root}). Move to one of: ${list || "none"}. To work outside it, use absolute paths or a new session (peer create with cwd).`);
	}
	if (real(there.top) === real(own.top)) return null;
	if (!allowed(there.top)) throw new Error(`${there.top} is outside the workspace this server may use`);
	return there.top;
}

/** "path (branch x)", for the notes below. */
export function placeText(dir: string): string {
	const branch = repoOf(dir)?.branch;
	return `${dir}${branch ? ` (branch ${branch})` : ""}`;
}

/** What the agent is told when its working folder changed: by its own `workdir` call, by the user, or because it was removed. */
export function movedNote(cwd: string, from: string, to: string | null, by: "agent" | "user" | "gone"): string {
	const here = placeText(to ?? cwd);
	if (by === "gone") return `[pipaya] ${from} no longer exists, so this session works in ${here} again: tool calls start there.`;
	const who = by === "user" ? "The user moved this session" : "This session moved";
	return `[pipaya] ${who} from ${from} to ${here}: bash starts there and relative paths resolve against it.${to ? ` Its own folder is ${cwd} (workdir back).` : ""}`;
}

/**
 * The hint for a call that worked in another working tree of the session's repository without moving there (a `cd`
 * into it, an edit under it), or null. Looking or running one command there is fine; staying is what `workdir` is for.
 */
export function stayHint(cwd: string, current: string, touched: string | null): string | null {
	if (!touched) return null;
	let dir = touched;
	while (!isDir(dir) && dirname(dir) !== dir) dir = dirname(dir);
	const own = repoOf(cwd);
	const there = repoOf(dir);
	if (!own || !there || real(there.root) !== real(own.root) || real(there.top) === real(repoOf(current)?.top ?? current)) return null;
	return `[pipaya] That call worked in ${placeText(there.top)}, but this session still works in ${current}. If the work continues there, call workdir (action move, path ${there.top}) so later calls start there and the user sees the session there.`;
}

/** The working tree the session moved into is gone (removed with `git worktree remove`, deleted): it goes home. */
export const isGone = (activeDir: string | null | undefined): activeDir is string => !!activeDir && !existsSync(activeDir);
