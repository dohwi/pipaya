import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { memberAt } from "./member-names.ts";

/**
 * `@group` mentions. A tagged group (or session) is handed to the model as a short index, one line per session, never as
 * transcripts: the model pulls detail with peer_read only for the sessions it needs, so the cost of a tag stays small
 * and does not grow with how much the group has said.
 */

/** Most sessions listed for one tag, and the cap on a whole hint, so a big group or many tags cannot flood the prompt. */
export const MAX_LISTED = 12;
export const MAX_HINT_CHARS = 3000;
const SNIPPET_CHARS = 100;

/** What a group is called in a message: its name with whitespace turned into "-" so the tag stays one token. */
export const groupHandle = (name: string): string => name.trim().replace(/\s+/g, "-");

/** Groups written as `@handle` in a message, in order of appearance, without repeats. A session name of the same length or longer wins the token. */
export function mentionedGroups(text: string, groups: readonly { name: string }[], memberNames: readonly string[] = []): string[] {
	const handles = groups.map((g) => groupHandle(g.name)).filter(Boolean);
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const handle = memberAt(m[1]!, handles);
		if (!handle || out.includes(handle)) continue;
		const member = memberAt(m[1]!, memberNames);
		if (member && member.length >= handle.length) continue;
		out.push(handle);
	}
	return out;
}

export interface MemberBrief {
	name: string;
	purpose: string;
	cwd: string;
	/** Git branch of its working directory, when it is a repository */
	branch: string | null;
	running: boolean;
	/** The last thing it said, any length (cut here) */
	last: string;
}

const oneLine = (s: string, max: number): string => {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One line of the index: `@name (role) · working · branch x · /path · last: "…"` */
export function briefLine(b: MemberBrief): string {
	const parts = [`@${b.name}${b.purpose ? ` (${oneLine(b.purpose, 60)})` : ""}`, b.running ? "working" : "idle"];
	if (b.branch) parts.push(`branch ${b.branch}`);
	parts.push(b.cwd);
	if (b.last) parts.push(`last: "${oneLine(b.last, SNIPPET_CHARS)}"`);
	return parts.join(" · ");
}

const READ_NOTE =
	"This is only an index. Do not guess what they did: read a session with peer_read (a few messages) only when you need its words, and prefer git (branch, log, diff in its directory) for the work itself. Use peer_send to give a session work (to a whole tagged group, pass the group name as `to` once).";

/** The note for tagged groups; `groups` maps a group handle to its sessions. */
export function groupHint(open: string, groups: readonly { handle: string; members: readonly MemberBrief[] }[]): string {
	const blocks = groups.map((g) => {
		const shown = g.members.slice(0, MAX_LISTED);
		const more = g.members.length - shown.length;
		const lines = shown.map((m) => `- ${briefLine(m)}`);
		if (more > 0) lines.push(`- (+${more} more; peer_read by name if needed)`);
		return `Group @${g.handle} (${g.members.length} sessions):\n${lines.join("\n")}`;
	});
	let body = blocks.join("\n");
	if (body.length > MAX_HINT_CHARS) body = `${body.slice(0, MAX_HINT_CHARS)}\n[index cut]`;
	return `${open}The user tagged ${groups.length === 1 ? "a group" : "groups"} of sessions on this server (they run independently).\n${body}\n${READ_NOTE}</pipaya-hint>`;
}

/** The note for tagged single sessions: the same one-line index instead of a bare name. */
export function memberBriefHint(open: string, members: readonly MemberBrief[]): string {
	const lines = members.slice(0, MAX_LISTED).map((m) => `- ${briefLine(m)}`).join("\n");
	return `${open}The user mentioned other sessions (agents) on this server:\n${lines}\n${READ_NOTE}</pipaya-hint>`;
}

/** peer_read output limits: each message is cut, and the whole answer is capped, newest messages kept. */
export const PEER_READ_MESSAGE_CHARS = 600;
export const PEER_READ_TOTAL_CHARS = 6000;

export function capPeerRead(lines: string[]): string {
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.length > PEER_READ_MESSAGE_CHARS ? `${lines[i]!.slice(0, PEER_READ_MESSAGE_CHARS)}…` : lines[i]!;
		if (size + line.length > PEER_READ_TOTAL_CHARS && kept.length) break;
		kept.unshift(line);
		size += line.length + 1;
	}
	const dropped = lines.length - kept.length;
	return `${dropped > 0 ? `[${dropped} older message(s) left out; ask for fewer/more with count]\n` : ""}${kept.join("\n")}`;
}

/** The checked-out branch of the repository holding `cwd` (a worktree too), read from HEAD without starting git. null = not a repository / detached. */
export function branchOf(cwd: string): string | null {
	try {
		for (let dir = resolve(cwd), i = 0; i < 12; i++, dir = dirname(dir)) {
			const dot = join(dir, ".git");
			if (existsSync(dot)) {
				let gitDir = dot;
				if (statSync(dot).isFile()) {
					const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
					if (!target) return null;
					gitDir = isAbsolute(target) ? target : resolve(dir, target);
				}
				return /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1]?.trim() ?? null;
			}
			if (dirname(dir) === dir) break;
		}
	} catch {}
	return null;
}
