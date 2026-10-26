import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { conflict, notFound } from "./errors.ts";
import { groupHandle, mentioned, nameInLang, nextMemberName, poolForLang, poolOfName } from "./member-names.ts";
import type { SessionRecord, SessionStore } from "./store.ts";

/**
 * Sessions talking to each other: every active session has an `@name`, an agent can message (`peer_send`) and read
 * (`peer_read`) another session or a whole tagged group, and `@name` / `@group` in a user message hands the agent a short
 * index of those sessions (never transcripts).
 */

export const HINT_OPEN = "<pipaya-hint>";
/** How many messages one run may send to other sessions; keeps two sessions from answering each other forever. */
export const MAX_SENDS_PER_RUN = 10;
const MESSAGE_CHARS = 600;
const TOTAL_CHARS = 6000;
const MAX_LISTED = 12;
const MAX_HINT_CHARS = 3000;
const SNIPPET_CHARS = 100;
const READ_NOTE =
	"This is only an index. Do not guess what they did: read a session with peer_read (a few messages) only when you need its words, and prefer git (branch, log, diff in its directory) for the work itself. Use peer_send to give a session work (to a whole tagged group, pass the group name as `to` once).";

export interface Brief { name: string; purpose: string; cwd: string; branch: string | null; running: boolean; last: string }
export interface GroupRef { name: string; sessionIds: string[] }

/** The checked-out branch of the repository holding `cwd` (a worktree too), read from HEAD without starting git. */
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

const oneLine = (s: string, max: number) => {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Newest lines first until the total cap; long lines are cut. */
export function capLines(lines: string[]): string {
	const kept: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.length > MESSAGE_CHARS ? `${lines[i]!.slice(0, MESSAGE_CHARS)}…` : lines[i]!;
		if (size + line.length > TOTAL_CHARS && kept.length) break;
		kept.unshift(line);
		size += line.length + 1;
	}
	const dropped = lines.length - kept.length;
	return `${dropped > 0 ? `[${dropped} older message(s) left out; ask for fewer/more with count]\n` : ""}${kept.join("\n")}`;
}

export function briefLine(b: Brief): string {
	const parts = [`@${b.name}${b.purpose ? ` (${oneLine(b.purpose, 60)})` : ""}`, b.running ? "working" : "idle"];
	if (b.branch) parts.push(`branch ${b.branch}`);
	parts.push(b.cwd);
	if (b.last) parts.push(`last: "${oneLine(b.last, SNIPPET_CHARS)}"`);
	return parts.join(" · ");
}

export function groupHint(groups: readonly { handle: string; members: readonly Brief[] }[]): string {
	const blocks = groups.map((g) => {
		const shown = g.members.slice(0, MAX_LISTED);
		const more = g.members.length - shown.length;
		const lines = shown.map((m) => `- ${briefLine(m)}`);
		if (more > 0) lines.push(`- (+${more} more; peer_read by name if needed)`);
		return `Group @${g.handle} (${g.members.length} sessions):\n${lines.join("\n")}`;
	});
	let body = blocks.join("\n");
	if (body.length > MAX_HINT_CHARS) body = `${body.slice(0, MAX_HINT_CHARS)}\n[index cut]`;
	return `${HINT_OPEN}The user tagged ${groups.length === 1 ? "a group" : "groups"} of sessions on this server (they run independently).\n${body}\n${READ_NOTE}</pipaya-hint>`;
}

export function memberBriefHint(members: readonly Brief[]): string {
	return `${HINT_OPEN}The user mentioned other sessions (agents) on this server:\n${members.slice(0, MAX_LISTED).map((m) => `- ${briefLine(m)}`).join("\n")}\n${READ_NOTE}</pipaya-hint>`;
}

/** What `PeerService` needs from the session layer. */
export interface PeerHost {
	store: SessionStore;
	groups(): GroupRef[];
	isRunning(id: string): boolean;
	/** Queue a user message: `follow_up` while the session works, otherwise `prompt`. */
	deliver(id: string, text: string, mode: "prompt" | "follow_up"): Promise<unknown>;
	/** Change a session's name and tell the clients. */
	rename(id: string, name: string): void;
}

export class PeerService {
	/** `peer_send` calls in each session's current run. */
	private sends = new Map<string, number>();

	constructor(private host: PeerHost) {}

	/** Starts a new run of this session: its send allowance is full again. */
	resetRun(id: string): void {
		this.sends.delete(id);
	}

	// ── names ───────────────────────────────────────────────────────────────

	/** Lower-cased names a session must not take: the active sessions' and the tags of the groups. */
	taken(): Set<string> {
		const taken = this.host.store.activeNames();
		for (const g of this.host.groups()) taken.add(groupHandle(g.name).toLowerCase());
		return taken;
	}

	/** A free name for a new session in the language of the UI that made it. */
	newName(lang?: string): string {
		return nextMemberName(this.taken(), poolForLang(lang));
	}

	/** The name a session takes back when reopened: its own, unless another session has it by now (or it never had one). */
	resumedName(r: SessionRecord): string {
		return r.name && !this.taken().has(r.name.toLowerCase()) ? r.name : nextMemberName(this.taken(), poolOfName(r.name));
	}

	/** The UI language changed: every session gets the twin of its name in it (민수 <-> Minsu). Returns how many were renamed. */
	localize(lang: string): number {
		const pool = poolForLang(lang);
		let renamed = 0;
		for (const r of this.host.store.list({ limit: 1000 })) {
			let name = nameInLang(r.name, lang);
			if (name === r.name) continue;
			if (!r.closed && this.taken().has(name.toLowerCase())) name = nextMemberName(this.taken(), pool);
			this.host.rename(r.id, name);
			renamed++;
		}
		return renamed;
	}

	// ── addressing ──────────────────────────────────────────────────────────

	/** The other active sessions, read fresh on every call. */
	private others(selfId: string): SessionRecord[] {
		return this.host.store.list({ limit: 1000, closed: false }).filter((r) => r.id !== selfId && r.name);
	}

	private find(selfId: string, name: string): SessionRecord {
		const all = this.others(selfId);
		const peer = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
		if (!peer) throw notFound(`session @${name} (sessions: ${all.map((p) => `@${p.name}`).join(", ") || "none"})`);
		return peer;
	}

	/** A one-line picture of a session for a tag: role, state, branch, directory and its last words. Never the transcript. */
	private brief(id: string): Brief | null {
		const r = this.host.store.get(id);
		if (!r || r.closed || !r.name) return null;
		const lastAssistant = this.host.store.lastMessages(id, 6).reverse().find((x) => x.message.role === "assistant");
		const parts = (Array.isArray(lastAssistant?.message.content) ? lastAssistant!.message.content : []) as { type: string; text?: string }[];
		const last = parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
		return { name: r.name, purpose: r.purpose, cwd: r.cwd, branch: branchOf(r.cwd), running: this.host.isRunning(id), last };
	}

	// ── tools ───────────────────────────────────────────────────────────────

	/** `peer_send`: to one session by name, or to every other session of a group by its handle. */
	async send(selfId: string, to: string, message: string): Promise<string> {
		const name = to.replace(/^@/, "");
		const all = this.others(selfId);
		const isSession = all.some((p) => p.name.toLowerCase() === name.toLowerCase());
		const group = isSession ? undefined : this.host.groups().find((g) => groupHandle(g.name).toLowerCase() === name.toLowerCase());
		const targets = group ? all.filter((p) => group.sessionIds.includes(p.id)) : [this.find(selfId, name)];
		if (group && !targets.length) throw notFound(`active sessions in group @${name} other than yourself`);
		const count = (this.sends.get(selfId) ?? 0) + 1;
		if (count > MAX_SENDS_PER_RUN) throw conflict(`at most ${MAX_SENDS_PER_RUN} peer messages per run; stop and report to the user instead`);
		this.sends.set(selfId, count);
		const self = this.host.store.get(selfId)?.name;
		const body = `[from @${self}, another session on this server; answer with peer_send to @${self} only if a reply is needed]\n${message}`;
		const done = await Promise.all(targets.map(async (t) => {
			const busy = this.host.isRunning(t.id);
			await this.host.deliver(t.id, body, busy ? "follow_up" : "prompt");
			return `@${t.name}${busy ? " (busy; waits for its turn to end)" : ""}`;
		}));
		return `Sent to ${group ? `group @${name}: ` : ""}${done.join(", ")}. They work on their own; use peer_read to check on them later.`;
	}

	/** `peer_read`: the latest messages of another session, text only. */
	read(selfId: string, from: string, count: number): string {
		const peer = this.find(selfId, from.replace(/^@/, ""));
		const rows = this.host.store.lastMessages(peer.id, Math.min(40, Math.max(1, count)));
		if (!rows.length) return `@${peer.name} has no messages yet.`;
		const lines = rows.map(({ message: m }) => {
			const parts = (Array.isArray(m.content) ? m.content : []) as { type: string; text?: string; name?: string }[];
			const body = parts.map((c) => (c.type === "text" && !c.text?.startsWith(HINT_OPEN) ? c.text : c.type === "toolCall" ? `[tool ${c.name}]` : "")).filter(Boolean).join(" ");
			return `${m.role === "user" ? "user" : m.role === "assistant" ? `@${peer.name}` : m.role}: ${body}`;
		});
		return `${this.host.isRunning(peer.id) ? `@${peer.name} is still working.\n` : ""}${capLines(lines)}`;
	}

	// ── mentions ────────────────────────────────────────────────────────────

	/** `@name` / `@group` in a user message: the hint blocks to add for the model. */
	hints(selfId: string, text: string): string[] {
		if (!text.includes("@")) return [];
		const peers = this.others(selfId);
		if (!peers.length) return [];
		const names = peers.map((p) => p.name);
		const groups = this.host.groups();
		const out: string[] = [];
		const handles = groups.map((g) => groupHandle(g.name)).filter(Boolean);
		// A token that is both a session name and a group handle belongs to the session.
		const named = mentioned(text, names);
		const tagged = mentioned(text, handles).filter((h) => !named.some((n) => n.toLowerCase() === h.toLowerCase()));
		const found = tagged.map((h) => {
			const g = groups.find((x) => groupHandle(x.name) === h)!;
			return { handle: h, members: g.sessionIds.filter((sid) => sid !== selfId).flatMap((sid) => { const b = this.brief(sid); return b ? [b] : []; }) };
		}).filter((g) => g.members.length);
		if (found.length) out.push(groupHint(found));
		const asked = mentioned(text, names);
		if (asked.length) {
			const briefs = asked.flatMap((n) => { const p = peers.find((x) => x.name === n); const b = p && this.brief(p.id); return b ? [b] : []; });
			out.push(briefs.length ? memberBriefHint(briefs) : `${HINT_OPEN}The user mentioned ${asked.map((n) => `@${n}`).join(", ")}: other sessions (agents) on this server. Use peer_send to give them work or ask them something, and peer_read to look at what they said or did. Do not guess what they did.</pipaya-hint>`);
		}
		return out;
	}
}
