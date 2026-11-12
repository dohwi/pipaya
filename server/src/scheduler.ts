import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import Type, { type Static, type TSchema } from "typebox";
import { badRequest, conflict, HttpError, notFound } from "./errors.ts";
import { DAY_MS } from "./retention.ts";

/**
 * Scheduled tasks: a prompt sent to an existing session once, or every so often.
 *
 * One timer is armed at a time, for the enabled task that is due first (unref'd, cut into pieces when it is further away than
 * setTimeout can count). The due time is kept in the database, so a restart arms it again. A run that finds its session busy or
 * closed is skipped and recorded: it is never queued and never wakes a session. After downtime a missed task runs once, not once
 * per missed slot; a one-time task more than a day late is switched off instead of run.
 *
 * Invariant: `nextRunAt` is set exactly when the task is enabled.
 */

export const MAX_TASKS = 50;
export const MIN_EVERY_MS = 5 * 60_000;
export const MAX_EVERY_MS = 30 * DAY_MS;
export const MAX_PROMPT = 8000;
export const MAX_TITLE = 100;
/** A one-time task this much past its time (server was off) is not run any more. */
export const EXPIRE_AFTER_MS = DAY_MS;
/** This many failed runs in a row switch an interval task off. */
export const MAX_FAILS = 5;
/** The longest delay setTimeout accepts (2^31 - 1 ms, about 24.8 days); a later task re-arms when this fires. */
export const MAX_TIMER_MS = 2_147_483_647;
const RETRY_FLOOR_MS = 1000;

export const ScheduleStatus = Type.Union([
	Type.Literal("ok"),
	Type.Literal("skipped_busy"),
	Type.Literal("skipped_closed"),
	Type.Literal("skipped_expired"),
	Type.Literal("error"),
]);
export type ScheduleStatusValue = Static<typeof ScheduleStatus>;

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

export const ScheduleSchema = Type.Object({
	id: Type.String(),
	sessionId: Type.String(),
	title: Nullable(Type.String()),
	prompt: Type.String(),
	kind: Type.Union([Type.Literal("once"), Type.Literal("interval")]),
	runAt: Nullable(Type.Integer({ description: "once: when to run (ms)" })),
	everyMs: Nullable(Type.Integer({ description: "interval: time between runs (ms)" })),
	enabled: Type.Boolean(),
	nextRunAt: Nullable(Type.Integer({ description: "When it runs next (ms); null while switched off" })),
	lastRunAt: Nullable(Type.Integer({ description: "When it last ran or was skipped (ms)" })),
	lastStatus: Nullable(ScheduleStatus),
	lastError: Nullable(Type.String()),
	failCount: Type.Integer({ description: "Failed runs in a row" }),
	createdAt: Type.Integer(),
	updatedAt: Type.Integer(),
});
export type ScheduleRecord = Static<typeof ScheduleSchema>;
export const ScheduleList = Type.Object({ schedules: Type.Array(ScheduleSchema) });

export const CreateScheduleBody = Type.Object({
	sessionId: Type.String(),
	title: Type.Optional(Nullable(Type.String())),
	prompt: Type.String({ description: `1 to ${MAX_PROMPT} characters` }),
	kind: Type.Union([Type.Literal("once"), Type.Literal("interval")]),
	runAt: Type.Optional(Nullable(Type.Integer({ description: "once only: a time in the future (ms)" }))),
	everyMs: Type.Optional(Nullable(Type.Integer({ description: `interval only: ${MIN_EVERY_MS} to ${MAX_EVERY_MS} ms` }))),
});
export type CreateScheduleInput = Static<typeof CreateScheduleBody>;

export const PatchScheduleBody = Type.Object({
	title: Type.Optional(Nullable(Type.String())),
	prompt: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	runAt: Type.Optional(Nullable(Type.Integer())),
	everyMs: Type.Optional(Nullable(Type.Integer())),
});
export type PatchScheduleInput = Static<typeof PatchScheduleBody>;

export const ScheduleQuery = Type.Object({ sessionId: Type.Optional(Type.String()) });

interface Row {
	id: string;
	session_id: string;
	title: string | null;
	prompt: string;
	kind: "once" | "interval";
	run_at: number | null;
	every_ms: number | null;
	enabled: number;
	next_run_at: number | null;
	last_run_at: number | null;
	last_status: ScheduleStatusValue | null;
	last_error: string | null;
	fail_count: number;
	created_at: number;
	updated_at: number;
}

const toRecord = (r: Row): ScheduleRecord => ({
	id: r.id,
	sessionId: r.session_id,
	title: r.title,
	prompt: r.prompt,
	kind: r.kind,
	runAt: r.run_at,
	everyMs: r.every_ms,
	enabled: r.enabled === 1,
	nextRunAt: r.next_run_at,
	lastRunAt: r.last_run_at,
	lastStatus: r.last_status,
	lastError: r.last_error,
	failCount: r.fail_count,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** What the scheduler needs from the session manager; the app wires it, a test fakes it. */
export interface SchedulerHost {
	/** undefined = no such session. */
	session(id: string): { closed: boolean } | undefined;
	isRunning(id: string): boolean;
	send(id: string, input: { text: string; mode: "prompt"; origin: "schedule" }): Promise<unknown>;
}

export interface Timers {
	set(fn: () => void | Promise<void>, ms: number): unknown;
	clear(handle: unknown): void;
}

const realTimers: Timers = {
	set: (fn, ms) => {
		const t = setTimeout(() => void fn(), ms);
		t.unref?.();
		return t;
	},
	clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
	now?: () => number;
	timers?: Timers;
	/** Something changed (create / update / delete / a run): the app tells the clients. */
	onChange?: (change: { id: string | null; action: "created" | "updated" | "deleted" | "ran" }) => void;
	log?: (msg: string) => void;
}

export function checkPrompt(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw badRequest("prompt must not be empty");
	if (value.length > MAX_PROMPT) throw badRequest(`prompt is too long (at most ${MAX_PROMPT} characters)`);
	return value;
}

function checkTitle(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw badRequest("title must be a string");
	const title = value.trim();
	if (title.length > MAX_TITLE) throw badRequest(`title is too long (at most ${MAX_TITLE} characters)`);
	return title || null;
}

function checkEvery(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)) throw badRequest("everyMs is required for an interval task");
	if (value < MIN_EVERY_MS) throw badRequest(`the interval must be at least ${MIN_EVERY_MS / 60_000} minutes`);
	if (value > MAX_EVERY_MS) throw badRequest(`the interval must be at most ${MAX_EVERY_MS / DAY_MS} days`);
	return value;
}

export class Scheduler {
	private timer: unknown = null;
	private stopped = true;
	/** A tick is working through the due tasks: no timer is armed meanwhile (it would start a second tick), the tick arms one at its end. */
	private ticking = false;
	/** Tasks being sent right now: a second run of the same task is refused until it is through. */
	private inflight = new Set<string>();
	private now: () => number;
	private timers: Timers;
	private onChange: NonNullable<SchedulerOptions["onChange"]>;
	private log: (msg: string) => void;

	constructor(private db: Database, private host: SchedulerHost, opts: SchedulerOptions = {}) {
		this.now = opts.now ?? Date.now;
		this.timers = opts.timers ?? realTimers;
		this.onChange = opts.onChange ?? (() => {});
		this.log = opts.log ?? (() => {});
	}

	// ── reading ──

	private row(id: string): Row | undefined {
		return (this.db.query("SELECT * FROM scheduled_tasks WHERE id = $id").get({ id }) as Row | null) ?? undefined;
	}

	find(id: string): ScheduleRecord | undefined {
		const r = this.row(id);
		return r && toRecord(r);
	}

	get(id: string): ScheduleRecord {
		const r = this.find(id);
		if (!r) throw notFound("schedule");
		return r;
	}

	list(sessionId?: string): ScheduleRecord[] {
		const rows = (sessionId
			? this.db.query("SELECT * FROM scheduled_tasks WHERE session_id = $sessionId ORDER BY created_at, id").all({ sessionId })
			: this.db.query("SELECT * FROM scheduled_tasks ORDER BY created_at, id").all()) as Row[];
		return rows.map(toRecord);
	}

	// ── writing ──

	create(input: CreateScheduleInput): ScheduleRecord {
		const now = this.now();
		const prompt = checkPrompt(input.prompt);
		const title = checkTitle(input.title);
		if (!this.host.session(input.sessionId)) throw notFound("session");
		let runAt: number | null = null;
		let everyMs: number | null = null;
		let next: number;
		if (input.kind === "once") {
			if (input.everyMs !== undefined && input.everyMs !== null) throw badRequest("everyMs belongs to an interval task");
			if (typeof input.runAt !== "number") throw badRequest("runAt is required for a one-time task");
			if (input.runAt <= now) throw badRequest("runAt must be in the future");
			runAt = next = input.runAt;
		} else {
			if (input.runAt !== undefined && input.runAt !== null) throw badRequest("runAt belongs to a one-time task");
			everyMs = checkEvery(input.everyMs);
			next = now + everyMs;
		}
		const id = randomUUID();
		// Counted and inserted in one transaction, so two requests cannot both take the last place.
		this.db.transaction(() => {
			const { n } = this.db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as { n: number };
			if (n >= MAX_TASKS) throw badRequest(`at most ${MAX_TASKS} scheduled tasks`);
			this.db
				.query(
					`INSERT INTO scheduled_tasks (id, session_id, title, prompt, kind, run_at, every_ms, enabled, next_run_at, fail_count, created_at, updated_at)
					 VALUES ($id, $sessionId, $title, $prompt, $kind, $runAt, $everyMs, 1, $next, 0, $now, $now)`,
				)
				.run({ id, sessionId: input.sessionId, title, prompt, kind: input.kind, runAt, everyMs, next, now });
		})();
		this.changed(id, "created");
		return this.get(id);
	}

	update(id: string, patch: PatchScheduleInput): ScheduleRecord {
		const cur = this.row(id);
		if (!cur) throw notFound("schedule");
		const now = this.now();
		const prompt = patch.prompt !== undefined ? checkPrompt(patch.prompt) : cur.prompt;
		const title = patch.title !== undefined ? checkTitle(patch.title) : cur.title;
		let runAt = cur.run_at;
		let everyMs = cur.every_ms;
		if (patch.runAt !== undefined) {
			if (cur.kind !== "once") throw badRequest("runAt belongs to a one-time task");
			if (typeof patch.runAt !== "number") throw badRequest("runAt must be a time");
			if (patch.runAt <= now) throw badRequest("runAt must be in the future");
			runAt = patch.runAt;
		}
		if (patch.everyMs !== undefined) {
			if (cur.kind !== "interval") throw badRequest("everyMs belongs to an interval task");
			everyMs = checkEvery(patch.everyMs);
		}
		const wasOn = cur.enabled === 1;
		const on = patch.enabled ?? wasOn;
		let next: number | null = null;
		if (on) {
			if (cur.kind === "once") {
				const moved = runAt !== cur.run_at;
				if (!wasOn && !moved && cur.run_at! <= now) throw badRequest("the time has passed; set a new runAt to switch it on again");
				next = wasOn && !moved ? cur.next_run_at : runAt;
			} else {
				next = wasOn && everyMs === cur.every_ms ? cur.next_run_at : now + everyMs!;
			}
		}
		this.db
			.query(
				`UPDATE scheduled_tasks SET title = $title, prompt = $prompt, run_at = $runAt, every_ms = $everyMs, enabled = $on, next_run_at = $next,
				 fail_count = CASE WHEN $on = 1 AND $wasOn = 0 THEN 0 ELSE fail_count END, updated_at = $now WHERE id = $id`,
			)
			.run({ id, title, prompt, runAt, everyMs, on: on ? 1 : 0, wasOn: wasOn ? 1 : 0, next, now });
		this.changed(id, "updated");
		return this.get(id);
	}

	delete(id: string): void {
		if (!this.db.query("DELETE FROM scheduled_tasks WHERE id = $id").run({ id }).changes) throw notFound("schedule");
		this.changed(id, "deleted");
	}

	/** The session is gone. Its rows went with it (foreign key; deleted here too in case the key is off); this makes the timer and the clients notice. */
	onSessionDeleted(sessionId: string): void {
		this.db.query("DELETE FROM scheduled_tasks WHERE session_id = $sessionId").run({ sessionId });
		this.changed(null, "deleted");
	}

	// ── running ──

	/** Runs a task now. 409 when its session is running or closed, or the task is being sent right now. A one-time task is used up by it. */
	async runNow(id: string): Promise<ScheduleRecord> {
		const cur = this.row(id);
		if (!cur) throw notFound("schedule");
		await this.execute(cur, "manual");
		return this.get(id);
	}

	/** Runs everything that is due, then arms the timer for what comes next. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.runDue();
		} finally {
			this.ticking = false;
			this.arm(RETRY_FLOOR_MS);
		}
	}

	private async runDue(): Promise<void> {
		for (const { id } of this.dueRows()) {
			// Read again: an earlier run in this loop took time, and the task may have been changed or deleted meanwhile.
			const cur = this.row(id);
			if (!cur || !cur.enabled || cur.next_run_at === null || cur.next_run_at > this.now()) continue;
			try {
				await this.execute(cur, "timer");
			} catch (e) {
				this.log(`scheduler: ${id}: ${String(e)}`);
			}
		}
	}

	private dueRows(): Row[] {
		return this.db.query("SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $now ORDER BY next_run_at, id").all({ now: this.now() }) as Row[];
	}

	private async execute(cur: Row, trigger: "timer" | "manual"): Promise<void> {
		const id = cur.id;
		const now = this.now();
		// Switched off after more than a day of downtime: a "tomorrow morning" prompt is not wanted next week.
		if (trigger === "timer" && cur.kind === "once" && now - cur.next_run_at! > EXPIRE_AFTER_MS) {
			this.db
				.query("UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, last_status = 'skipped_expired', last_error = NULL, updated_at = $now WHERE id = $id")
				.run({ id, now });
			this.changed(id, "ran");
			return;
		}
		const session = this.host.session(cur.session_id);
		if (!session) {
			// Deleted under us (the foreign key normally took the row along already).
			this.db.query("DELETE FROM scheduled_tasks WHERE id = $id").run({ id });
			return;
		}
		const skip: ScheduleStatusValue | null = session.closed ? "skipped_closed" : this.inflight.has(id) || this.host.isRunning(cur.session_id) ? "skipped_busy" : null;
		if (skip && trigger === "manual") throw conflict(skip === "skipped_closed" ? "session is closed; resume it first" : "session is busy; try again when its run has finished");

		// Move the schedule on before sending: a crash or a slow send must not make the same slot run twice.
		// A manual run leaves an interval's rhythm alone; any run uses a one-time task up.
		if (cur.kind === "once") {
			this.db.query("UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, updated_at = $now WHERE id = $id").run({ id, now });
		} else if (trigger === "timer") {
			this.db.query("UPDATE scheduled_tasks SET next_run_at = $next, updated_at = $now WHERE id = $id").run({ id, now, next: now + cur.every_ms! });
		}
		if (skip) {
			this.record(id, now, skip, null, false);
			return;
		}
		this.inflight.add(id);
		let status: ScheduleStatusValue = "ok";
		let error: string | null = null;
		try {
			await this.host.send(cur.session_id, { text: cur.prompt, mode: "prompt", origin: "schedule" });
		} catch (e) {
			if (e instanceof HttpError && e.status === 409) status = "skipped_busy"; // it started between our look and the send
			else {
				status = "error";
				error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
			}
		} finally {
			this.inflight.delete(id);
		}
		this.record(id, now, status, error, status === "error");
		if (trigger === "manual" && status === "skipped_busy") throw conflict("session is busy; try again when its run has finished");
	}

	/** Writes the outcome. Touches only the result columns, so an edit made while the prompt was being sent is kept, and a deleted task stays deleted. */
	private record(id: string, at: number, status: ScheduleStatusValue, error: string | null, failed: boolean): void {
		const touched = this.db
			.query(
				`UPDATE scheduled_tasks SET last_run_at = $at, last_status = $status, last_error = $error,
				 fail_count = CASE WHEN $status = 'ok' THEN 0 WHEN $failed = 1 THEN fail_count + 1 ELSE fail_count END WHERE id = $id`,
			)
			.run({ id, at, status, error, failed: failed ? 1 : 0 }).changes;
		if (!touched) return;
		const after = this.row(id);
		if (after && after.enabled && after.fail_count >= MAX_FAILS) {
			this.db.query("UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, updated_at = $now WHERE id = $id").run({ id, now: this.now() });
			this.log(`scheduler: ${id} switched off after ${MAX_FAILS} failed runs in a row`);
		}
		this.changed(id, "ran");
	}

	// ── timer ──

	/** Arms the timer for the first task that is due, and takes up what was left from before the server stopped. */
	start(): void {
		this.stopped = false;
		this.arm();
	}

	stop(): void {
		this.stopped = true;
		this.disarm();
	}

	private disarm(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
	}

	/** `floor`: the shortest wait. After a tick it keeps a task that could not be moved on from turning into a busy loop. */
	private arm(floor = 0): void {
		this.disarm();
		if (this.stopped || this.ticking) return;
		const first = this.db.query("SELECT MIN(next_run_at) AS at FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL").get() as { at: number | null };
		if (first.at === null) return;
		const wait = Math.max(floor, first.at - this.now());
		const capped = wait > MAX_TIMER_MS;
		this.timer = this.timers.set(() => {
			this.timer = null;
			// Further away than a timer can count: look again at the cap instead of running.
			return capped ? this.arm() : this.tick();
		}, Math.min(wait, MAX_TIMER_MS));
	}

	private changed(id: string | null, action: "created" | "updated" | "deleted" | "ran"): void {
		this.arm();
		try {
			this.onChange({ id, action });
		} catch {
			/* telling the clients must never break the scheduler */
		}
	}
}
