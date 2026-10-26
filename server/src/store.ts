import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ContextSnapshot } from "./context.ts";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SessionRecord {
	id: string;
	title: string;
	/** What this session's agent works on, written by the system model; "" until then. */
	purpose: string;
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	tools: string[];
	parentId: string | null;
	/** Closed sessions are hidden from the active list until resumed. */
	closed: boolean;
	/** Archived sessions stay open but are tucked away by the apps; a new message brings them back. */
	archived: boolean;
	createdAt: number;
	updatedAt: number;
}

interface SessionRow {
	id: string;
	title: string;
	purpose: string;
	cwd: string;
	provider: string;
	model: string;
	thinking_level: string;
	system_prompt: string;
	tools: string;
	parent_id: string | null;
	closed: number;
	archived: number;
	created_at: number;
	updated_at: number;
}

const toRecord = (r: SessionRow): SessionRecord => ({
	id: r.id,
	title: r.title,
	purpose: r.purpose ?? "",
	cwd: r.cwd,
	provider: r.provider,
	model: r.model,
	thinkingLevel: r.thinking_level as ThinkingLevel,
	systemPrompt: r.system_prompt,
	tools: JSON.parse(r.tools),
	parentId: r.parent_id,
	closed: r.closed === 1,
	archived: r.archived === 1,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export type SessionPatch = Partial<
	Pick<SessionRecord, "title" | "purpose" | "provider" | "model" | "thinkingLevel" | "systemPrompt" | "tools" | "closed" | "archived">
>;

const PATCH_COLUMNS: Record<keyof SessionPatch, string> = {
	title: "title",
	purpose: "purpose",
	provider: "provider",
	model: "model",
	thinkingLevel: "thinking_level",
	systemPrompt: "system_prompt",
	tools: "tools",
	closed: "closed",
	archived: "archived",
};

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
				`INSERT INTO sessions (id, title, purpose, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at)
				 VALUES ($id, $title, $purpose, $cwd, $provider, $model, $thinking, $system, $tools, $parent, $created, $updated)`,
			)
			.run({
				id: r.id,
				title: r.title,
				purpose: r.purpose,
				cwd: r.cwd,
				provider: r.provider,
				model: r.model,
				thinking: r.thinkingLevel,
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
	list(opts: { limit: number; before?: number; closed?: boolean }): SessionRecord[] {
		const rows = this.db
			.query(
				`SELECT * FROM sessions WHERE updated_at < $before AND ($closed IS NULL OR closed = $closed)
				 ORDER BY updated_at DESC LIMIT $limit`,
			)
			.all({
				before: opts.before ?? Number.MAX_SAFE_INTEGER,
				limit: opts.limit,
				closed: opts.closed === undefined ? null : opts.closed ? 1 : 0,
			}) as SessionRow[];
		return rows.map(toRecord);
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

	update(id: string, patch: SessionPatch): SessionRecord | undefined {
		const sets: string[] = ["updated_at = $updated"];
		const params: Record<string, string | number> = { id, updated: Date.now() };
		for (const key of Object.keys(patch) as (keyof SessionPatch)[]) {
			const value = patch[key];
			if (value === undefined) continue;
			sets.push(`${PATCH_COLUMNS[key]} = $${key}`);
			params[key] = key === "tools" ? JSON.stringify(value) : key === "closed" || key === "archived" ? (value ? 1 : 0) : (value as string);
		}
		this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = $id`).run(params);
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

	messages(sessionId: string, opts: { after?: number; limit?: number } = {}): StoredMessage[] {
		const rows = this.db
			.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid AND seq > $after ORDER BY seq LIMIT $limit")
			.all({ sid: sessionId, after: opts.after ?? -1, limit: opts.limit ?? -1 }) as {
			seq: number;
			role: string;
			data: string;
			created_at: number;
		}[];
		return rows.map((r) => ({ seq: r.seq, role: r.role, createdAt: r.created_at, message: JSON.parse(r.data) }));
	}

	/** Only the toolResult messages of one tool, filtered in SQL so other messages are never parsed. */
	toolResults(sessionId: string, toolName: string): StoredMessage[] {
		const rows = this.db
			.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid AND role = 'toolResult' AND json_extract(data, '$.toolName') = $tool ORDER BY seq")
			.all({ sid: sessionId, tool: toolName }) as { seq: number; role: string; data: string; created_at: number }[];
		return rows.map((r) => ({ seq: r.seq, role: r.role, createdAt: r.created_at, message: JSON.parse(r.data) }));
	}

	/** The newest `n` messages, oldest first (reads only those rows, not the whole transcript). */
	lastMessages(sessionId: string, n: number): StoredMessage[] {
		const rows = this.db
			.query("SELECT seq, role, data, created_at FROM messages WHERE session_id = $sid ORDER BY seq DESC LIMIT $n")
			.all({ sid: sessionId, n }) as { seq: number; role: string; data: string; created_at: number }[];
		return rows.reverse().map((r) => ({ seq: r.seq, role: r.role, createdAt: r.created_at, message: JSON.parse(r.data) }));
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
		return {
			input: main.input + summaries.input,
			output: main.output + summaries.output,
			cacheRead: main.cacheRead + summaries.cacheRead,
			cacheWrite: main.cacheWrite + summaries.cacheWrite,
			totalTokens: main.totalTokens + summaries.totalTokens,
			cost: main.cost + summaries.cost,
			turns: main.turns ?? 0,
		};
	}
}

export interface CompactionRecord { uptoSeq: number; summary: string; tokensBefore: number; createdAt: number }

/** pi-ai CredentialStore backed by SQLite so API keys survive restarts. */
export class SqliteCredentialStore implements CredentialStore {
	private chains = new Map<string, Promise<unknown>>();

	constructor(private db: Database) {}

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
		const prev = this.chains.get(providerId) ?? Promise.resolve();
		const next = prev
			.catch(() => {})
			.then(async () => {
				const updated = await fn(await this.read(providerId));
				if (updated) {
					this.db
						.query("INSERT INTO credentials (provider_id, data) VALUES ($id, $data) ON CONFLICT(provider_id) DO UPDATE SET data = $data")
						.run({ id: providerId, data: JSON.stringify(updated) });
					return updated;
				}
				return this.read(providerId);
			});
		this.chains.set(providerId, next);
		return next;
	}

	async delete(providerId: string): Promise<void> {
		return this.deleteWithCleanup(providerId);
	}

	/** Optional synchronous cleanup participates in the same SQLite transaction as key deletion. */
	async deleteWithCleanup(providerId: string, cleanup?: () => void): Promise<void> {
		const prev = this.chains.get(providerId) ?? Promise.resolve();
		const next = prev.catch(() => {}).then(() => this.db.transaction(() => {
			cleanup?.();
			this.db.query("DELETE FROM credentials WHERE provider_id = $id").run({ id: providerId });
		})());
		this.chains.set(providerId, next);
		await next;
	}
}
