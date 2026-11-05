import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { conflict, notFound } from "./errors.ts";
import { groupHandle, mentioned, nameInLang, nextMemberName, poolForLang, poolOfName } from "./member-names.ts";
import type { QuestionAnswer, QuestionRequest } from "./questions.ts";
import type { SessionPatch, SessionRecord, SessionStore, ThinkingLevel } from "./store.ts";

/**
 * Sessions talking to each other: every active session has an `@name`, an agent can message (`peer(action=send)`) and read
 * (`peer(action=read)`) another session or a whole tagged group, and `@name` / `@group` in a user message hands the agent a short
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
export const READ_NOTE =
	"This is only an index. Do not guess what they did: read a session with peer(action=read) (a few messages) only when you need its words, and prefer git (branch, log, diff in its directory) for the work itself. Use peer(action=send) to give a session work (to a whole tagged group, pass the group name as `to` once).";

/** Wording of what a peer message looks like to the receiving session (`peer(action=send)`). */
export const PEER_MESSAGE_TEMPLATE = "[from @${sender}, another session on this server; answer with peer(action=send) to @${sender} only if a reply is needed]\n${message}";
/** Fills the template in one pass, so a `${sender}` or `${message}` typed inside the message itself is never expanded. */
export const peerMessage = (self: string | undefined, message: string): string =>
	PEER_MESSAGE_TEMPLATE.replace(/\$\{(sender|message)\}/g, (_, key: string) => (key === "sender" ? String(self) : message));

export interface Brief { name: string; purpose: string; cwd: string; branch: string | null; running: boolean; last: string }
export interface GroupRef { name: string; sessionIds: string[] }

/** Group changes a session may make (the app wires them to the group manager). Each returns a one-line result. */
export interface GroupOps {
	create(name: string | undefined, sessionIds: string[]): string;
	add(group: string, sessionIds: string[]): string;
	remove(group: string, sessionIds: string[]): string;
	dissolve(group: string): string;
}

export interface PeerCreateInput {
	message: string;
	title?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	purpose?: string;
	notify?: boolean;
}

export type ManageAction = "close" | "resume" | "delete" | "cancel_queued" | "rename" | "set";
export interface ManageArgs { mode?: "steer" | "follow_up"; text?: string; newName?: string; purpose?: string; provider?: string; model?: string; thinkingLevel?: ThinkingLevel }

/** A new name must stay readable as an @mention. */
const NAME_RE = /^[\p{L}\p{N}_-]{1,30}$/u;

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

/** A finished run's report carries the whole last reply (a one-line cut hid the end of it); only an extreme one is cut. */
const REPORT_CHARS = 12000;
const fullText = (s: string, max: number) => {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1)}… (cut; peer(action=read) has the rest)` : t;
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
		if (more > 0) lines.push(`- (+${more} more; peer(action=read) by name if needed)`);
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
	deliver(id: string, text: string, mode: "prompt" | "steer" | "follow_up"): Promise<unknown>;
	/** Change a session's name and tell the clients. */
	rename(id: string, name: string): void;
	/** Tuck a session away in the archive (or bring it back). */
	archive(id: string, archived: boolean): void;
	/** Stop a session's current run; false when there was nothing to stop. */
	abort(id: string): boolean;
	/** Calls `fn` whenever any session's run ends. */
	onRunFinished(fn: (id: string, result: { status?: string; error?: string | null }) => void): void;
	/** Calls `fn` whenever a session asks its user (ask_user) and waits. */
	onQuestion(fn: (id: string, q: QuestionRequest) => void): void;
	/** Questions a session is waiting on. */
	questions(id: string): QuestionRequest[];
	/** Answer a waiting question; false when nothing matched or the answer is invalid. */
	answer(id: string, toolCallId: string, a: QuestionAnswer): "ok" | "not_found" | "invalid";
	/** A new session; `send` starts its first run. */
	create(input: { title?: string; cwd?: string; provider?: string; model?: string; thinkingLevel?: ThinkingLevel }, parentId: string): Promise<SessionRecord>;
	/** Close (stops its work) / resume / delete a session. */
	update(id: string, patch: SessionPatch): void;
	remove(id: string): void;
	/** Drop one not-yet-delivered steer/follow_up message. */
	cancelQueued(id: string, mode: "steer" | "follow_up", text: string): boolean;
	/** Texts still waiting in a session's queues. */
	queued(id: string): { mode: "steer" | "follow_up"; text: string }[];
	groupOps: GroupOps;
}

export class PeerService {
	/** `peer(action=send)` calls in each session's current run. */
	private sends = new Map<string, number>();

	/** Questions already reported to a watcher (`sessionId:toolCallId`), so a restart or replay cannot report one twice. */
	private reported = new Set<string>();

	/** Watchers (who asked for `notify`) live in the database, so a restart does not lose them. They get one report per ended run. */
	constructor(private host: PeerHost) {
		host.onRunFinished((id, result) => this.finished(id, result));
		host.onQuestion((id, q) => this.asked(id, q));
	}

	private tell(watcher: string, body: string): void {
		const r = this.host.store.get(watcher);
		if (!r || r.closed) return;
		void this.host.deliver(watcher, body, this.host.isRunning(watcher) ? "follow_up" : "prompt").catch(() => {});
	}

	/** A watched session asks its user something and waits: nobody would notice, so the watchers hear it now (and may answer with peer(action=answer)). */
	private asked(id: string, q: QuestionRequest): void {
		const watching = this.host.store.watchers(id);
		if (!watching.length) return;
		const key = `${id}:${q.toolCallId}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		const name = this.host.store.get(id)?.name ?? "session";
		const items = q.items?.length ? q.items : [{ question: q.question, options: q.options, recommended: q.recommended, allowFreeText: q.allowFreeText }];
		const lines = items.map((it, i) => `${items.length > 1 ? `${i + 1}. ` : ""}${oneLine(it.question, 500)}${it.options?.length ? ` [options: ${it.options.join(" | ")}]` : ""}${it.recommended ? ` (recommended: ${it.recommended})` : ""}${it.allowFreeText ? "" : " (pick one option)"}`);
		const body = `[from the server: @${name} is waiting for an answer and does nothing until it gets one. No reply to this message needed.]\n${lines.join("\n")}\nAnswer it with peer(action=answer) (name: ${name}) if you can decide with what you know; if it needs the user's judgment, ask the user instead.`;
		for (const w of watching) this.tell(w, body);
	}

	/** A watched session ended its run: tell each watcher once. The report asks for no reply, so it cannot start a loop. */
	private finished(id: string, result: { status?: string; error?: string | null }): void {
		const watching = this.host.store.watchers(id);
		if (!watching.length) return;
		this.host.store.unwatch(id);
		const b = this.brief(id);
		const name = b?.name ?? this.host.store.get(id)?.name ?? "session";
		const state = result.status === "ok" || !result.status ? "finished its run" : `ended its run (${result.status}${result.error ? `: ${oneLine(result.error, 200)}` : ""})`;
		const body = `[from the server: @${name} ${state}. This is a report you asked for; no reply needed.]${b?.branch ? `\nbranch: ${b.branch}` : ""}${b?.last ? `\nlast words: "${oneLine(b.last, 400)}"` : ""}\nUse peer(action=read) for more, peer(action=send) for follow-up work, peer(action=archive) when it is done.`;
		for (const w of watching) {
			const r = this.host.store.get(w);
			if (!r || r.closed) continue;
			void this.host.deliver(w, body, this.host.isRunning(w) ? "follow_up" : "prompt").catch(() => {});
		}
	}

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

	/** `peer(action=send)`: to one session by name, or to every other session of a group by its handle. */
	async send(selfId: string, to: string, message: string, opts: { mode?: "steer" | "follow_up"; notify?: boolean } = {}): Promise<string> {
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
		const body = peerMessage(self, message);
		const done = await Promise.all(targets.map(async (t) => {
			const busy = this.host.isRunning(t.id);
			const had = this.host.store.watchers(t.id).includes(selfId);
			if (opts.notify) this.host.store.watch(t.id, selfId);
			try {
				await this.host.deliver(t.id, body, busy ? (opts.mode ?? "follow_up") : "prompt");
			} catch (e) {
				if (opts.notify && !had) this.host.store.unwatch(t.id, selfId);
				throw e;
			}
			return `@${t.name}${busy ? (opts.mode === "steer" ? " (busy; steered into its current run)" : " (busy; waits for its turn to end)") : ""}`;
		}));
		return `Sent to ${group ? `group @${name}: ` : ""}${done.join(", ")}. They work on their own; ${opts.notify ? "you get one report when each ends its run" : "use peer(action=read) to check on them later"}.`;
	}

	/** `peer(action=list)`: every other open session with its state, so an orchestrator sees who is working, idle or archived. */
	list(selfId: string): string {
		const rows = this.others(selfId);
		if (!rows.length) return "No other sessions.";
		return rows.map((r) => {
			const parts = [`@${r.name}`, this.host.isRunning(r.id) ? "working" : "idle"];
			if (r.archived) parts.push("archived");
			if (r.title) parts.push(`"${oneLine(r.title, 60)}"`);
			const branch = branchOf(r.cwd);
			if (branch) parts.push(`branch ${branch}`);
			parts.push(r.cwd);
			return `- ${parts.join(" · ")}`;
		}).join("\n");
	}

	/** `peer(action=archive)`: tuck a finished session away (or bring it back). A working session is refused: stop it first. */
	archive(selfId: string, name: string, archived: boolean): string {
		const peer = this.find(selfId, name.replace(/^@/, ""));
		if (archived && this.host.isRunning(peer.id)) throw conflict(`@${peer.name} is still working; wait for its report or stop it with peer(action=abort) first`);
		this.host.archive(peer.id, archived);
		return `@${peer.name} ${archived ? "archived" : "restored"}.`;
	}

	/** `peer(action=abort)`: stop the current run of another session. */
	abort(selfId: string, name: string): string {
		const peer = this.find(selfId, name.replace(/^@/, ""));
		return this.host.abort(peer.id) ? `Stopped @${peer.name}.` : `@${peer.name} was not working.`;
	}

	/** `peer(action=answer)`: answer the question another session is waiting on (what the user would do in the app). */
	answer(selfId: string, name: string, a: { answer?: string; answers?: string[]; toolCallId?: string }): string {
		const peer = this.find(selfId, name.replace(/^@/, ""));
		const waiting = this.host.questions(peer.id);
		if (!waiting.length) return `@${peer.name} is not waiting for an answer.`;
		const q = a.toolCallId ? waiting.find((x) => x.toolCallId === a.toolCallId) : waiting[0];
		if (!q) throw notFound(`question ${a.toolCallId} of @${peer.name}`);
		const r = this.host.answer(peer.id, q.toolCallId, { answer: a.answer, answers: a.answers });
		if (r === "invalid") throw conflict(q.items?.length ? `answer every question: pass \`answers\` with ${q.items.length} entries, each one of its options when free text is not allowed` : q.options?.length && !q.allowFreeText ? `the answer must be one of: ${q.options.join(" | ")}` : "the answer must not be empty");
		if (r === "not_found") return `@${peer.name} is not waiting any more.`;
		return `Answered @${peer.name}.${waiting.length > 1 ? ` ${waiting.length - 1} more question(s) still wait.` : ""}`;
	}

	/** `peer(action=create)`: a new session that starts on `message`. The caller hears when it ends or asks something, unless `notify` is false. */
	async create(selfId: string, input: PeerCreateInput): Promise<string> {
		const count = (this.sends.get(selfId) ?? 0) + 1;
		if (count > MAX_SENDS_PER_RUN) throw conflict(`at most ${MAX_SENDS_PER_RUN} peer messages per run; stop and report to the user instead`);
		this.sends.set(selfId, count);
		const own = this.host.store.get(selfId);
		const r = await this.host.create({ title: input.title, cwd: input.cwd ?? own?.cwd, provider: input.provider, model: input.model, thinkingLevel: input.thinkingLevel }, selfId);
		if (input.purpose) this.host.update(r.id, { purpose: input.purpose.slice(0, 200) });
		const notify = input.notify ?? true;
		if (notify) this.host.store.watch(r.id, selfId);
		try {
			await this.host.deliver(r.id, peerMessage(own?.name, input.message), "prompt");
		} catch (e) {
			this.host.store.unwatch(r.id);
			this.host.remove(r.id); // a session that never got its task is of no use
			throw e;
		}
		return `Created @${r.name} (${r.provider}/${r.model}, ${r.cwd}) and gave it the task. ${notify ? "You get a report when it ends its run or asks a question." : "Use peer(action=read) to check on it."}`;
	}

	/** A session of this server by name, closed ones too (`peer(action=close|resume|delete|rename|set)` resume). */
	private findAny(selfId: string, name: string): SessionRecord {
		const n = name.replace(/^@/, "").toLowerCase();
		const active = this.others(selfId).find((p) => p.name.toLowerCase() === n);
		if (active) return active;
		const closed = this.host.store.list({ limit: 1000, closed: true }).filter((r) => r.id !== selfId && r.name.toLowerCase() === n).sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (!closed) throw notFound(`session @${n}`);
		return closed;
	}

	/** `peer(action=close|resume|delete|rename|set)`: close, resume, delete, rename, change the model, or take back a queued message. */
	manage(selfId: string, name: string, action: ManageAction, a: ManageArgs = {}): string {
		const peer = action === "resume" ? this.findAny(selfId, name) : this.find(selfId, name.replace(/^@/, ""));
		switch (action) {
			case "close":
				this.host.update(peer.id, { closed: true });
				return `Closed @${peer.name} (its work is stopped; resume it later with action resume, its name is given back).`;
			case "resume":
				if (!peer.closed) return `@${peer.name} is already open.`;
				this.host.update(peer.id, { closed: false });
				return `Resumed @${this.host.store.get(peer.id)?.name ?? peer.name}.`;
			case "delete": {
				// Deleting loses the transcript for good: only what this session started itself, and only when it is not working.
				if (peer.parentId !== selfId) throw conflict(`only sessions you created with peer(action=create) can be deleted; close @${peer.name} instead`);
				if (this.host.isRunning(peer.id)) throw conflict(`@${peer.name} is still working; stop it with peer(action=abort) first`);
				this.host.remove(peer.id);
				return `Deleted @${peer.name}.`;
			}
			case "cancel_queued": {
				const queue = this.host.queued(peer.id).filter((q) => !a.mode || q.mode === a.mode);
				if (!a.text) return queue.length ? `Queued for @${peer.name}:\n${queue.map((q) => `- ${q.mode}: ${oneLine(q.text, 200)}`).join("\n")}\nPass \`text\` (a piece of the message) to take one back.` : `Nothing is queued for @${peer.name}.`;
				const hit = queue.find((q) => q.text.includes(a.text!));
				if (!hit) throw notFound(`queued message containing "${oneLine(a.text, 60)}" for @${peer.name}`);
				return this.host.cancelQueued(peer.id, hit.mode, hit.text) ? `Took back the queued ${hit.mode} message of @${peer.name}.` : "That message was already delivered.";
			}
			case "rename": {
				const to = (a.newName ?? "").replace(/^@/, "");
				if (!NAME_RE.test(to)) throw conflict("the new name must be 1-30 letters, digits, - or _");
				if (to.toLowerCase() !== peer.name.toLowerCase() && this.taken().has(to.toLowerCase())) throw conflict(`@${to} is already taken by a session or a group`);
				this.host.rename(peer.id, to);
				return `Renamed @${peer.name} to @${to}.`;
			}
			case "set": {
				const patch: SessionPatch = {};
				if (a.purpose !== undefined) patch.purpose = a.purpose.slice(0, 200);
				if (a.provider !== undefined) patch.provider = a.provider;
				if (a.model !== undefined) patch.model = a.model;
				if (a.thinkingLevel !== undefined) patch.thinkingLevel = a.thinkingLevel;
				if (!Object.keys(patch).length) throw conflict("nothing to change: pass purpose, provider/model or thinkingLevel");
				this.host.update(peer.id, patch);
				return `Updated @${peer.name}: ${Object.entries(patch).map(([k, v]) => `${k}=${oneLine(String(v), 60)}`).join(", ")}.`;
			}
		}
	}

	/** `peer(action=group_*)`: arrange sessions into a tagged group, the way the user does in the app. */
	group(selfId: string, action: "create" | "add" | "remove" | "dissolve", a: { group?: string; members?: string[]; name?: string }): string {
		const own = this.host.store.get(selfId);
		const ids = [...new Set((a.members ?? []).map((m) => {
			const n = m.replace(/^@/, "").toLowerCase();
			return own && own.name.toLowerCase() === n ? own.id : this.find(selfId, n).id;
		}))];
		const need = (): string => {
			if (!a.group) throw conflict("pass `group` (the group name)");
			return a.group.replace(/^@/, "");
		};
		switch (action) {
			case "create":
				if (ids.length < 2) throw conflict("a group needs at least 2 members");
				return this.host.groupOps.create(a.name, ids);
			case "add":
				if (!ids.length) throw conflict("pass `members`");
				return this.host.groupOps.add(need(), ids);
			case "remove":
				if (!ids.length) throw conflict("pass `members`");
				return this.host.groupOps.remove(need(), ids);
			case "dissolve":
				return this.host.groupOps.dissolve(need());
		}
	}

	/** `peer(action=read)`: the latest messages of another session, text only. */
	read(selfId: string, from: string, count: number, detail = false): string {
		const peer = this.find(selfId, from.replace(/^@/, ""));
		const rows = this.host.store.lastMessages(peer.id, Math.min(40, Math.max(1, count)));
		const waiting = this.host.questions(peer.id);
		const status = [
			this.host.isRunning(peer.id) ? `@${peer.name} is still working.` : "",
			waiting.length ? `@${peer.name} waits for an answer (peer(action=answer)): ${waiting.map((q) => oneLine(q.question, 200)).join(" / ")}` : "",
		].filter(Boolean).join("\n");
		if (!rows.length) return `${status ? `${status}\n` : ""}@${peer.name} has no messages yet.`;
		const lines = rows.map(({ message: m }) => {
			const parts = (Array.isArray(m.content) ? m.content : []) as { type: string; text?: string; name?: string; arguments?: unknown }[];
			const body = parts.map((c) => {
				if (c.type === "text") return c.text?.startsWith(HINT_OPEN) ? "" : c.text;
				if (c.type !== "toolCall") return "";
				return detail ? `[tool ${c.name} ${oneLine(JSON.stringify(c.arguments ?? {}), 200)}]` : `[tool ${c.name}]`;
			}).filter(Boolean).join(" ");
			// With details a tool result shows the tool's name, whether it failed, and its output cut to a line or two.
			if (detail && m.role === "toolResult") {
				const r = m as unknown as { isError?: boolean; toolName?: string };
				return `${r.isError ? "tool ERROR" : "tool result"} ${r.toolName ?? ""}: ${oneLine(body, 400)}`;
			}
			return `${m.role === "user" ? "user" : m.role === "assistant" ? `@${peer.name}` : m.role}: ${body}`;
		}).filter(Boolean);
		return `${status ? `${status}\n` : ""}${capLines(lines)}`;
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
			out.push(briefs.length ? memberBriefHint(briefs) : `${HINT_OPEN}The user mentioned ${asked.map((n) => `@${n}`).join(", ")}: other sessions (agents) on this server. Use peer(action=send) to give them work or ask them something, and peer(action=read) to look at what they said or did. Do not guess what they did.</pipaya-hint>`);
		}
		return out;
	}
}
