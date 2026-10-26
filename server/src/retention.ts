import type { Database } from "bun:sqlite";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { SessionStore } from "./store.ts";

/**
 * Session retention: chats not used for a number of days are deleted, once an hour and shortly after the server starts.
 * Off until the user turns it on. A session that is running, or waiting for an answer, is never deleted, whatever its age.
 */

export const DAY_MS = 24 * 3600_000;
export const RETENTION_EVERY_MS = 3600_000;
/** Shortly after start, so a server that was off for a while does not wait a full hour. */
export const RETENTION_FIRST_MS = 30_000;
export const MIN_DAYS = 1;
export const MAX_DAYS = 3650;

export const RetentionSettingsSchema = Type.Object(
	{
		enabled: Type.Boolean({ description: "Delete sessions that have not been used for `days` days" }),
		days: Type.Integer({ minimum: MIN_DAYS, maximum: MAX_DAYS, description: "Days without use after which a session is deleted" }),
		onlyClosed: Type.Boolean({ description: "Only delete closed sessions; active ones are kept however old" }),
	},
	{ additionalProperties: false },
);
export type RetentionSettingsValue = Static<typeof RetentionSettingsSchema>;
export const DEFAULT_RETENTION = (): RetentionSettingsValue => ({ enabled: false, days: 30, onlyClosed: true });

export const RetentionInfo = Type.Object({
	settings: RetentionSettingsSchema,
	defaults: RetentionSettingsSchema,
	lastRun: Type.Union([Type.Integer(), Type.Null()], { description: "When the last clean-up ran (ms); null = never" }),
	lastDeleted: Type.Integer({ description: "Sessions the last clean-up deleted" }),
	due: Type.Integer({ description: "Sessions the policy would delete now (0 while off)" }),
});
export const RetentionRunResult = Type.Object({ deleted: Type.Integer() });

const KEY = "retention";
const STATE_KEY = "retention_state";
const PAGE = 500;

export class Retention {
	private timer: ReturnType<typeof setInterval> | null = null;
	private first: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private db: Database,
		private store: SessionStore,
		/** Running or waiting for an answer: never deleted. */
		private busy: (id: string) => boolean,
		private remove: (id: string) => void,
		private log: (msg: string) => void = () => {},
	) {}

	private read(key: string): unknown {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key }) as { data: string } | null;
		if (!row) return undefined;
		try { return JSON.parse(row.data); } catch { return undefined; }
	}
	private write(key: string, value: unknown): void {
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key, data: JSON.stringify(value) });
	}

	get(): RetentionSettingsValue {
		const merged = { ...DEFAULT_RETENTION(), ...(this.read(KEY) as object | undefined) };
		return Value.Check(RetentionSettingsSchema, merged) ? merged : DEFAULT_RETENTION();
	}

	set(value: RetentionSettingsValue): RetentionSettingsValue {
		this.write(KEY, value);
		return this.get();
	}

	/** Ids the policy matches now, oldest first. */
	candidates(now = Date.now(), p = this.get()): string[] {
		if (!p.enabled) return [];
		const cutoff = now - p.days * DAY_MS;
		const out: string[] = [];
		// The list is newest first: start at the cutoff and page back to the oldest.
		for (let before = cutoff, i = 0; i < 1000; i++) {
			const page = this.store.list({ limit: PAGE, before, closed: p.onlyClosed ? true : undefined });
			for (const s of page) if (!this.busy(s.id)) out.push(s.id);
			if (page.length < PAGE) break;
			before = page[page.length - 1]!.updatedAt;
		}
		return out.reverse();
	}

	/** Deletes what the policy matches now. Returns how many went (0 while off). */
	run(now = Date.now()): number {
		const p = this.get();
		if (!p.enabled) return 0;
		let deleted = 0;
		for (const id of this.candidates(now, p)) {
			if (this.busy(id) || !this.store.get(id)) continue;
			try { this.remove(id); deleted++; } catch (e) { this.log(`retention: could not delete ${id}: ${String(e)}`); }
		}
		this.write(STATE_KEY, { lastRun: now, lastDeleted: deleted });
		if (deleted) this.log(`retention: deleted ${deleted} session(s) not used for ${p.days} days`);
		return deleted;
	}

	info(now = Date.now()) {
		const s = this.read(STATE_KEY) as { lastRun?: unknown; lastDeleted?: unknown } | undefined;
		return {
			settings: this.get(),
			defaults: DEFAULT_RETENTION(),
			lastRun: Number.isInteger(s?.lastRun) ? (s!.lastRun as number) : null,
			lastDeleted: Number.isInteger(s?.lastDeleted) ? (s!.lastDeleted as number) : 0,
			due: this.candidates(now).length,
		};
	}

	start(): void {
		const tick = () => { try { this.run(); } catch (e) { this.log(`retention: clean-up failed: ${String(e)}`); } };
		this.timer = setInterval(tick, RETENTION_EVERY_MS);
		this.first = setTimeout(tick, RETENTION_FIRST_MS);
		this.timer.unref?.();
		this.first.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.first) clearTimeout(this.first);
		this.timer = this.first = null;
	}
}
