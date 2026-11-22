import type { ServiceTier } from "./openrouter-catalog.ts";
import { parseJson } from "./json-column.ts";
import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ContextSnapshot } from "./context.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./shared/thinking.ts";

export { THINKING_LEVELS, type ThinkingLevel };

import { nameKey } from "./member-names.ts";

export interface SessionRecord {
	id: string;
	title: string;
	/** How other sessions address this one (`@name`); unique among all sessions, closed ones included (a closed one keeps its name for when it is reopened); "" for a closed one that never had one. */
	name: string;
	/** What this session's agent works on, written by the system model; "" until then. */
	purpose: string;
	cwd: string;
	/**
	 * Another git worktree of the cwd's repository the agent moved into and works in now (`cd ../app-x`, edits there);
	 * null while it works in its own. The sidebar lists the session under it. Tools still start in `cwd`.
	 */
	activeDir?: string | null;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	serviceTier?: ServiceTier | null;
	systemPrompt: string;
	tools: string[];
	parentId: string | null;
	/** Closed sessions are hidden from the active list until resumed. */
	closed: boolean;
	createdAt: number;
	updatedAt: number;
}

interface SessionRow {
	id: string;
	title: string;
	name: string;
	purpose: string;
	cwd: string;
	active_dir: string | null;
	provider: string;
	model: string;
	thinking_level: string;
	service_tier: ServiceTier | null;
	system_prompt: string;
	tools: string;
	parent_id: string | null;
	closed: number;
	created_at: number;
	updated_at: number;
}

const toRecord = (r: SessionRow): SessionRecord => ({
	id: r.id,
	title: r.title,
	name: r.name ?? "",
	purpose: r.purpose ?? "",
	cwd: r.cwd,
	activeDir: r.active_dir ?? null,
	provider: r.provider,
	model: r.model,
	thinkingLevel: r.thinking_level as ThinkingLevel,
	serviceTier: r.service_tier,
	systemPrompt: r.system_prompt,
	tools: parseJson<string[]>(r.tools, []), // a damaged list reads as no tools rather than hiding the session
	parentId: r.parent_id,
	closed: r.closed === 1,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export type SessionPatch = Partial<
	Pick<SessionRecord, "title" | "name" | "purpose" | "provider" | "model" | "thinkingLevel" | "serviceTier" | "systemPrompt" | "tools" | "closed">
>;

const PATCH_COLUMNS: Record<keyof SessionPatch, string> = {
	title: "title",
	name: "name",
	purpose: "purpose",
	provider: "provider",
	model: "model",
	thinkingLevel: "thinking_level",
	serviceTier: "service_tier",
	systemPrompt: "system_prompt",
	tools: "tools",
	closed: "closed",
};

interface MessageRow { seq: number; role: string; data: string; created_at: number }
const toStored = (r: MessageRow): StoredMessage => ({ seq: r.seq, role: r.role, createdAt: r.created_at, message: JSON.parse(r.data) });
/** How far a `wholeTurn` page reaches back for the prompt of a reply it starts inside (long agent runs stay well below). */
const TURN_REACH_MAX = 1000;

export interface StoredMessage {
	seq: number;
	role: string;
	createdAt: number;
	message: AgentMessage;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

export class SessionStore {
	constructor(private db: Database) {}

	create(r: SessionRecord): void {
		this.db
			.query(
				`INSERT INTO sessions (id, title, name, purpose, cwd, provider, model, thinking_level, service_tier, system_prompt, tools, parent_id, created_at, updated_at)
				 VALUES ($id, $title, $name, $purpose, $cwd, $provider, $model, $thinking, $tier, $system, $tools, $parent, $created, $updated)`,
			)
			.run({
				id: r.id,
				title: r.title,
				name: r.name,
				purpose: r.purpose,
				cwd: r.cwd,
				provider: r.provider,
				model: r.model,
				thinking: r.thinkingLevel,
				tier: r.serviceTier ?? null,
				system: r.systemPrompt,
				tools: JSON.stringify(r.tools),
				parent: r.parentId,
				created: r.createdAt,
				updated: r.updatedAt,
			});
	}

	get(id: string): SessionRecord | undefined {
		const row = this.db.query("SELECT * FROM sessions WHERE id = $id").get({ id }) as SessionRow | null;
		return row ? toRecord(row) : undefined;
	}

	/** `closed`: true = only closed, false = only active, undefined = both. */
	list(opts: { limit: number; before?: number; beforeId?: string; closed?: boolean }): SessionRecord[] {
		const rows = this.db
			.query(
				`SELECT * FROM sessions WHERE (updated_at, id) < ($before, $beforeId)${opts.closed === undefined ? "" : " AND closed = $closed"}
				 ORDER BY updated_at DESC, id DESC LIMIT $limit`,
			)
			.all({
				before: opts.before ?? Number.MAX_SAFE_INTEGER,
				limit: opts.limit,
				beforeId: opts.beforeId ?? null, // a legacy timestamp alone excludes every row at that time
				...(opts.closed === undefined ? {} : { closed: Number(opts.closed) }),
			}) as SessionRow[];
		return rows.map(toRecord);
	}

	/** `nameKey`s of the open sessions' names (only these answer to them): 철수 and Cheolsu are one key. */
	activeNames(): Set<string> {
		return new Set((this.db.query("SELECT name FROM sessions WHERE closed = 0 AND name != ''").all() as { name: string }[]).map((r) => nameKey(r.name)));
	}

	/** `nameKey`s of every session's name, closed ones included: a closed session keeps its name, so nobody else may take it. */
	allNames(): Set<string> {
		return new Set((this.db.query("SELECT DISTINCT name FROM sessions WHERE name != ''").all() as { name: string }[]).map((r) => nameKey(r.name)));
	}

	/** `watcher` wants a report about `target` (its end, its questions). */
	watch(target: string, watcher: string): void {
		this.db.query("INSERT OR IGNORE INTO peer_watch (target_id, watcher_id) VALUES ($target, $watcher)").run({ target, watcher });
	}

	unwatch(target: string, watcher?: string): void {
		if (watcher) this.db.query("DELETE FROM peer_watch WHERE target_id = $target AND watcher_id = $watcher").run({ target, watcher });
		else this.db.query("DELETE FROM peer_watch WHERE target_id = $target").run({ target });
	}

	watchers(target: string): string[] {
		return (this.db.query("SELECT watcher_id FROM peer_watch WHERE target_id = $target").all({ target }) as { watcher_id: string }[]).map((r) => r.watcher_id);
	}

	activeCount(): number {
		return (this.db.query("SELECT COUNT(*) AS n FROM sessions WHERE closed = 0").get() as { n: number }).n;
	}

	/** Working directories that have sessions, with how many are active / closed. */
	workdirs(): { cwd: string; active: number; closed: number; updatedAt: number }[] {
		return this.db
			.query(
				`SELECT cwd, SUM(closed = 0) AS active, SUM(closed = 1) AS closed, MAX(updated_at) AS updatedAt
				 FROM sessions GROUP BY cwd ORDER BY updatedAt DESC`,
			)
			.all() as { cwd: string; active: number; closed: number; updatedAt: number }[];
	}

	/**
	 * Every `delegate` call of the active sessions, oldest first: the call's arguments and, once it finished, what its
	 * result's details say (the model it really ran on, its turns and tokens). For the graph of who hands work to which
	 * subagent; the call and answer texts are left out. `instr` keeps SQLite from parsing the JSON of every message.
	 */
	delegateCalls(): (DelegateCall & { cwd: string; provider: string; sessionModel: string })[] {
		const calls = this.db
			.query(
				`SELECT m.session_id AS sessionId, s.cwd, s.provider, s.model AS sessionModel, m.created_at AS at, json_extract(c.value, '$.id') AS callId,
				        json_extract(c.value, '$.arguments.role') AS role, json_extract(c.value, '$.arguments.model') AS asked
				 FROM messages m JOIN sessions s ON s.id = m.session_id AND s.closed = 0, json_each(m.data, '$.content') c
				 WHERE m.role = 'assistant' AND instr(m.data, '"delegate"') > 0
				   AND json_extract(c.value, '$.type') = 'toolCall' AND json_extract(c.value, '$.name') = 'delegate'
				 ORDER BY m.created_at, m.seq`,
			)
			.all() as { sessionId: string; cwd: string; provider: string; sessionModel: string; at: number; callId: unknown; role: unknown; asked: unknown }[];
		type Result = { callId: string; at: number; isError: number | null; model: unknown; turns: unknown; tokens: unknown };
		const results = new Map(
			(
				this.db
					.query(
						`SELECT json_extract(m.data, '$.toolCallId') AS callId, m.created_at AS at, json_extract(m.data, '$.isError') AS isError,
						        json_extract(m.data, '$.details.model') AS model, json_extract(m.data, '$.details.turns') AS turns,
						        json_extract(m.data, '$.details.usage.totalTokens') AS tokens
						 FROM messages m JOIN sessions s ON s.id = m.session_id AND s.closed = 0
						 WHERE m.role = 'toolResult' AND instr(m.data, '"delegate"') > 0 AND json_extract(m.data, '$.toolName') = 'delegate'`,
					)
					.all() as Result[]
			).map((r) => [r.callId, r] as const),
		);
		const str = (v: unknown) => (typeof v === "string" && v ? v : null);
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
		return calls.flatMap((c) => {
			const callId = str(c.callId);
			const role = str(c.role)?.replace(/\.md$/, "");
			if (!callId || !role) return []; // a call written without a role is refused before anything runs
			const done = results.get(callId);
			return [{
				sessionId: c.sessionId, cwd: c.cwd, provider: c.provider, sessionModel: c.sessionModel, callId, role, asked: str(c.asked), at: c.at, doneAt: done?.at ?? null, error: !!done?.isError,
				model: str(done?.model), turns: num(done?.turns), tokens: num(done?.tokens),
			}];
		});
	}

	update(id: string, patch: SessionPatch): SessionRecord | undefined {
		const sets: string[] = ["updated_at = $updated"];
		const params: Record<string, string | number | null> = { id, updated: Date.now() };
		for (const key of Object.keys(patch) as (keyof SessionPatch)[]) {
			const value = patch[key];
			// a field this server does not know (an older client, a newer extension): leave the row alone rather than build bad SQL
			if (value === undefined || !(key in PATCH_COLUMNS)) continue;
			sets.push(`${PATCH_COLUMNS[key]} = $${key}`);
			params[key] = key === "tools" ? JSON.stringify(value) : key === "closed" ? (value ? 1 : 0) : (value as string);
		}
		this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $id`).run(params);
		return this.get(id);
	}

	/** Where the agent works now (see `SessionRecord.activeDir`); not a settings change, so the list order is left alone. */
	setActiveDir(id: string, dir: string | null): SessionRecord | undefined {
		this.db.query("UPDATE sessions SET active_dir = $dir WHERE id = $id").run({ id, dir });
		return this.get(id);
	}

	touch(id: string): void {
		this.db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() });
	}

	/** All or nothing: a crash halfway must not leave a session without its transcript, or events without their session. */
	delete(id: string): boolean {
		return this.db.transaction(() => {
			this.db.query("DELETE FROM messages WHERE session_id = $id").run({ id });
			this.db.query("DELETE FROM session_contexts WHERE session_id = $id").run({ id });
			this.db.query("DELETE FROM session_compactions WHERE session_id = $id").run({ id });
			this.db.query("DELETE FROM events WHERE session_id = $id").run({ id }); // events has no foreign key to cascade on
			return this.db.query("DELETE FROM sessions WHERE id = $id").run({ id }).changes > 0;
		})();
	}

	context(id: string): ContextSnapshot | undefined {
		const row = this.db.query("SELECT data FROM session_contexts WHERE session_id = $id").get({ id }) as { data: string } | null;
		return row ? JSON.parse(row.data) : undefined;
	}

	/** First writer wins: the captured base prompt, tools and cwd cannot be changed by later runs or reloads (AGENTS.md and skills are re-read live). */
	captureContext(id: string, snapshot: ContextSnapshot): ContextSnapshot {
		this.db.query("INSERT OR IGNORE INTO session_contexts (session_id, data) VALUES ($id, $data)")
			.run({ id, data: JSON.stringify(snapshot) });
		return this.context(id)!;
	}

	// ── messages ────────────────────────────────────────────────────────────

	appendMessage(sessionId: string, seq: number, message: AgentMessage): void {
		this.db
			.query("INSERT INTO messages (session_id, seq, role, data, created_at) VALUES ($sid, $seq, $role, $data, $t)")
			.run({ sid: sessionId, seq, role: message.role, data: JSON.stringify(message), t: Date.now() });
		this.touch(sessionId);
	}

	deleteLastMessage(sessionId: string): void {
		this.db
			.query("DELETE FROM messages WHERE session_id = $sid AND seq = (SELECT MAX(seq) FROM messages WHERE session_id = $sid)")
			.run({ sid: sessionId });
	}

	nextSeq(sessionId: string): number {
		const row = this.db
			.query("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM messages WHERE session_id = $sid")
			.get({ sid: sessionId }) as { n: number };
		return row.n;
	}

	messages(sessionId: string, opts: { after?: number; limit?: number; tail?: number; before?: number; wholeTurn?: boolean } = {}): StoredMessage[] {
		// `tail`: only the newest N (with seq below `before`), oldest first. Opening a long conversation needs just the end of it.
		if (opts.tail) {
			const after = opts.after ?? -1;
			const rows = this.db
				.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid AND seq > $after AND seq < $before ORDER BY seq DESC LIMIT $n")
				.all({ sid: sessionId, after, before: opts.before ?? Number.MAX_SAFE_INTEGER, n: opts.tail })
				.reverse() as MessageRow[];
			// `wholeTurn`: a page that starts inside a reply reaches back to the prompt it answers, so the client never
			// shows (and totals) half a reply that grows once the next page arrives. Capped for runaway agent loops.
			const first = rows[0];
			if (opts.wholeTurn && first && first.role !== "user" && first.seq > after + 1) {
				const prompt = this.db
					.query("SELECT MAX(seq) AS s FROM messages WHERE session_id = $sid AND role = 'user' AND seq > $after AND seq < $first")
					.get({ sid: sessionId, after, first: first.seq }) as { s: number | null };
				const from = Math.max(prompt.s ?? after + 1, first.seq - TURN_REACH_MAX);
				const lead = this.db
					.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid AND seq >= $from AND seq < $first ORDER BY seq")
					.all({ sid: sessionId, from, first: first.seq }) as MessageRow[];
				rows.unshift(...lead);
			}
			return rows.map(toStored);
		}
		return this.db
			.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid AND seq > $after ORDER BY seq LIMIT $limit")
			.all({ sid: sessionId, after: opts.after ?? -1, limit: opts.limit ?? -1 })
			.map((r) => toStored(r as MessageRow));
	}

	/** Only the toolResult messages of one tool, filtered in SQL so other messages are never parsed. */
	toolResults(sessionId: string, toolName: string): StoredMessage[] {
		return this.db
			.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid AND role = 'toolResult' AND json_extract(data, '$.toolName') = $tool ORDER BY seq")
			.all({ sid: sessionId, tool: toolName })
			.map((r) => toStored(r as MessageRow));
	}

	/** The newest `n` messages, oldest first (reads only those rows, not the whole transcript). */
	lastMessages(sessionId: string, n: number): StoredMessage[] {
		return this.db
			.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid ORDER BY seq DESC LIMIT $n")
			.all({ sid: sessionId, n })
			.reverse()
			.map((r) => toStored(r as MessageRow));
	}

	// ── compaction ──────────────────────────────────────────────────────────

	latestCompaction(sessionId: string): CompactionRecord | undefined {
		const row = this.db.query("SELECT upto_seq, summary, tokens_before, created_at FROM session_compactions WHERE session_id = $sid ORDER BY id DESC LIMIT 1").get({ sid: sessionId }) as
			{ upto_seq: number; summary: string; tokens_before: number; created_at: number } | null;
		return row ? { uptoSeq: row.upto_seq, summary: row.summary, tokensBefore: row.tokens_before, createdAt: row.created_at } : undefined;
	}

	addCompaction(sessionId: string, c: { uptoSeq: number; summary: string; tokensBefore: number; usage: Record<string, number> | null }): void {
		this.db.query("INSERT INTO session_compactions (session_id, upto_seq, summary, tokens_before, usage, created_at) VALUES ($sid, $upto, $summary, $before, $usage, $t)")
			.run({ sid: sessionId, upto: c.uptoSeq, summary: c.summary, before: c.tokensBefore, usage: c.usage ? JSON.stringify(c.usage) : null, t: Date.now() });
	}

	/** What the model sees: the latest summary (if any) followed by the messages after it. */
	projection(sessionId: string): { summary: string | null; messages: StoredMessage[] } {
		const c = this.latestCompaction(sessionId);
		return { summary: c?.summary ?? null, messages: this.messages(sessionId, { after: c?.uptoSeq ?? -1 }) };
	}

	/** Text of the newest assistant message that has any (a turn that ends in a tool call has none). */
	latestAssistantText(sessionId: string): string {
		const rows = this.db.query("SELECT data FROM messages WHERE session_id = $sid AND role = 'assistant' ORDER BY seq DESC LIMIT 6").all({ sid: sessionId }) as { data: string }[];
		for (const r of rows) {
			try {
				const m = JSON.parse(r.data) as { content?: { type: string; text?: string }[] };
				const text = (m.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ").trim();
				if (text) return text;
			} catch { /* a damaged row is skipped, not fatal */ }
		}
		return "";
	}

	/** Copy messages with seq <= upToSeq (all when omitted) into another session. */
	copyMessages(fromId: string, toId: string, upToSeq?: number): number {
		return this.db.transaction(() => {
			this.db.query(`INSERT INTO session_contexts (session_id, data)
				SELECT $to, data FROM session_contexts WHERE session_id = $from`)
				.run({ from: fromId, to: toId });
			this.db.query(`INSERT INTO session_compactions (session_id, upto_seq, summary, tokens_before, usage, created_at)
				SELECT $to, upto_seq, summary, tokens_before, usage, created_at FROM session_compactions WHERE session_id = $from AND upto_seq <= $upTo ORDER BY id`)
				.run({ from: fromId, to: toId, upTo: upToSeq ?? Number.MAX_SAFE_INTEGER });
			return this.db
				.query(
					`INSERT INTO messages (session_id, seq, role, data, created_at)
					 SELECT $to, seq, role, data, created_at FROM messages WHERE session_id = $from AND seq <= $upTo`,
				)
				.run({ from: fromId, to: toId, upTo: upToSeq ?? Number.MAX_SAFE_INTEGER }).changes;
		})();
	}

	/**
	 * Summed in SQLite (json_extract) instead of parsing every stored message in JS: this runs after every
	 * run and on each session fetch, and a long transcript made it the hottest path on the server.
	 */
	usage(sessionId: string): UsageTotals {
		// `base` is the JSON path of the usage object; `cost` the path of the cost number inside it.
		const sums = (col: string, base: string, cost: string) => {
			const n = (path: string) => `COALESCE(SUM(COALESCE(json_extract(${col}, '${path}'), 0)), 0)`;
			return `${n(`${base}.input`)} AS input, ${n(`${base}.output`)} AS output, ${n(`${base}.cacheRead`)} AS cacheRead, ` +
				`${n(`${base}.cacheWrite`)} AS cacheWrite, ${n(`${base}.totalTokens`)} AS totalTokens, ${n(cost)} AS cost`;
		};
		type Row = Omit<UsageTotals, "turns">;
		const run = (sql: string) => this.db.query(sql).get({ sid: sessionId }) as Row & { turns?: number };

		const main = run(
			`SELECT COUNT(*) AS turns, ${sums("data", "$.usage", "$.usage.cost.total")}
			 FROM messages WHERE session_id = $sid AND role = 'assistant' AND json_type(data, '$.usage') = 'object'`,
		);
		// Summaries are model calls too.
		const summaries = run(
			`SELECT ${sums("usage", "$", "$.cost")}
			 FROM session_compactions WHERE session_id = $sid AND usage IS NOT NULL`,
		);
		// Subagents of `delegate` are model calls too: their totals ride on the tool result's details.
		const subagents = run(
			`SELECT ${sums("data", "$.details.usage", "$.details.usage.cost")}
			 FROM messages WHERE session_id = $sid AND role = 'toolResult' AND json_extract(data, '$.toolName') = 'delegate' AND json_type(data, '$.details.usage') = 'object'`,
		);
		return {
			input: main.input + summaries.input + subagents.input,
			output: main.output + summaries.output + subagents.output,
			cacheRead: main.cacheRead + summaries.cacheRead + subagents.cacheRead,
			cacheWrite: main.cacheWrite + summaries.cacheWrite + subagents.cacheWrite,
			totalTokens: main.totalTokens + summaries.totalTokens + subagents.totalTokens,
			cost: main.cost + summaries.cost + subagents.cost,
			turns: main.turns ?? 0,
		};
	}
}

/** One `delegate` call (see `SessionStore.delegateCalls`). `doneAt` null = no result yet: running, or cut off by a restart. */
export interface DelegateCall {
	sessionId: string;
	callId: string;
	role: string;
	/** The `model` argument the agent passed, if any (the policy may have refused it). */
	asked: string | null;
	at: number;
	doneAt: number | null;
	error: boolean;
	/** provider/model it ran on, from the result; null while running or when it failed before starting. */
	model: string | null;
	turns: number | null;
	tokens: number | null;
}

export interface CompactionRecord { uptoSeq: number; summary: string; tokensBefore: number; createdAt: number }

/** pi-ai CredentialStore backed by SQLite so API keys survive restarts. */
export class SqliteCredentialStore implements CredentialStore {
	private chains = new Map<string, Promise<unknown>>();

	constructor(private db: Database) {}

	/** Serialises work per provider; the entry leaves the map once nothing newer is queued behind it. */
	private enqueue<T>(providerId: string, work: () => Promise<T>): Promise<T> {
		const next = (this.chains.get(providerId) ?? Promise.resolve()).catch(() => {}).then(work);
		this.chains.set(providerId, next);
		void next.then(() => {}, () => {}).then(() => { if (this.chains.get(providerId) === next) this.chains.delete(providerId); });
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const row = this.db.query("SELECT data FROM credentials WHERE provider_id = $id").get({ id: providerId }) as {
			data: string;
		} | null;
		return row ? (JSON.parse(row.data) as Credential) : undefined;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const rows = this.db.query("SELECT provider_id, data FROM credentials").all() as { provider_id: string; data: string }[];
		return rows.map((r) => ({ providerId: r.provider_id, type: (JSON.parse(r.data) as Credential).type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const updated = await fn(await this.read(providerId));
			if (updated) {
				this.db
					.query("INSERT INTO credentials (provider_id, data) VALUES ($id, $data) ON CONFLICT(provider_id) DO UPDATE SET data = $data")
					.run({ id: providerId, data: JSON.stringify(updated) });
				return updated;
			}
			return this.read(providerId);
		});
	}

	async delete(providerId: string): Promise<void> {
		return this.deleteWithCleanup(providerId);
	}

	/** Optional synchronous cleanup participates in the same SQLite transaction as key deletion. */
	async deleteWithCleanup(providerId: string, cleanup?: () => void): Promise<void> {
		await this.enqueue(providerId, async () => {
			this.db.transaction(() => {
				cleanup?.();
				this.db.query("DELETE FROM credentials WHERE provider_id = $id").run({ id: providerId });
			})();
		});
	}
}
