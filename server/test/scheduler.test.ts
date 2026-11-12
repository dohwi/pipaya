import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { HttpError } from "../src/errors.ts";
import { DAY_MS } from "../src/retention.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";
import { EXPIRE_AFTER_MS, MAX_EVERY_MS, MAX_FAILS, MAX_PROMPT, MAX_TASKS, MAX_TIMER_MS, MIN_EVERY_MS, Scheduler, type SchedulerHost, type Timers } from "../src/scheduler.ts";

const MIN = 60_000;
const T0 = 1_000_000_000_000;

/** A clock and a timer list that only move when the test says so. */
function fake() {
	let now = T0;
	let seq = 0;
	const pending = new Map<number, { at: number; fn: () => void | Promise<void>; ms: number }>();
	const timers: Timers = {
		set: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn, ms }); return id; },
		clear: (h) => { pending.delete(h as number); },
	};
	return {
		now: () => now,
		timers,
		pending,
		set: (t: number) => { now = t; },
		/** Moves the clock and fires the timers that fall due, in order. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				pending.delete(next[0]);
				now = Math.max(now, next[1].at);
				await next[1].fn();
			}
			now = end;
		},
	};
}

function setup(opts: { sessions?: Record<string, { closed: boolean }>; running?: string[]; sendError?: () => Error | undefined } = {}) {
	const db = openDb(":memory:");
	const clock = fake();
	const sessions: Record<string, { closed: boolean }> = opts.sessions ?? { s1: { closed: false } };
	const running = new Set(opts.running ?? []);
	const sent: { id: string; text: string; mode: string; origin: string }[] = [];
	const changes: string[] = [];
	const state = { sendError: opts.sendError, hold: null as Promise<void> | null };
	for (const id of Object.keys(sessions)) db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES (?, 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run(id);
	const host: SchedulerHost = {
		session: (id) => sessions[id],
		isRunning: (id) => running.has(id),
		send: async (id, input) => {
			sent.push({ id, text: input.text, mode: input.mode, origin: input.origin });
			if (state.hold) await state.hold;
			const err = state.sendError?.();
			if (err) throw err;
		},
	};
	const make = () => new Scheduler(db, host, { now: clock.now, timers: clock.timers, onChange: (c) => changes.push(`${c.action}`) });
	const scheduler = make();
	return { db, clock, scheduler, make, sessions, running, sent, changes, state, host };
}

const once = (s: Scheduler, runAt: number, extra: object = {}) => s.create({ sessionId: "s1", prompt: "hello", kind: "once", runAt, ...extra });
const every = (s: Scheduler, everyMs: number, extra: object = {}) => s.create({ sessionId: "s1", prompt: "tick", kind: "interval", everyMs, ...extra });
const status = (e: unknown) => (e as HttpError).status;
const fails = (fn: () => unknown): number => { try { fn(); } catch (e) { return status(e); } return 0; };

describe("Scheduler: running", () => {
	test("a one-time task sends its prompt as a schedule run at its time, then switches itself off", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		const t = once(scheduler, T0 + 10 * MIN);
		expect(clock.pending.size).toBe(1);
		await clock.advance(9 * MIN);
		expect(sent).toEqual([]);
		await clock.advance(MIN);
		expect(sent).toEqual([{ id: "s1", text: "hello", mode: "prompt", origin: "schedule" }]);
		expect(scheduler.get(t.id)).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: "ok", lastRunAt: T0 + 10 * MIN, failCount: 0 });
		expect(clock.pending.size).toBe(0); // nothing left to wait for
		await clock.advance(DAY_MS);
		expect(sent.length).toBe(1);
	});

	test("an interval task runs again at now + every_ms, counted from the run, not from the slot", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		const t = every(scheduler, 10 * MIN);
		expect(t.nextRunAt).toBe(T0 + 10 * MIN);
		await clock.advance(10 * MIN);
		expect(sent.length).toBe(1);
		expect(scheduler.get(t.id)).toMatchObject({ enabled: true, nextRunAt: T0 + 20 * MIN, lastStatus: "ok" });
		await clock.advance(25 * MIN);
		expect(sent.length).toBe(3);
		expect(scheduler.get(t.id).nextRunAt).toBe(T0 + 40 * MIN);
	});

	test("only one timer is armed, for the task that is due first", () => {
		const { scheduler, clock } = setup();
		scheduler.start();
		every(scheduler, 60 * MIN);
		every(scheduler, 20 * MIN);
		once(scheduler, T0 + 40 * MIN);
		expect(clock.pending.size).toBe(1);
		expect([...clock.pending.values()][0]!.ms).toBe(20 * MIN);
	});

	test("two tasks due together both run, one after the other", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		once(scheduler, T0 + MIN, { prompt: "a" });
		once(scheduler, T0 + MIN, { prompt: "b" });
		await clock.advance(MIN);
		expect(sent.map((s) => s.text).sort()).toEqual(["a", "b"]);
	});

	test("a task further away than setTimeout can count is armed in pieces and still runs on time", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		const t = every(scheduler, MAX_EVERY_MS); // 30 days > 24.8 days
		expect([...clock.pending.values()][0]!.ms).toBe(MAX_TIMER_MS);
		await clock.advance(MAX_TIMER_MS);
		expect(sent).toEqual([]); // the first piece only looks again
		expect(clock.pending.size).toBe(1);
		await clock.advance(MAX_EVERY_MS - MAX_TIMER_MS);
		expect(sent.length).toBe(1);
		expect(scheduler.get(t.id).lastStatus).toBe("ok");
	});

	test("stop clears the timer and nothing runs afterwards; start arms it again", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		every(scheduler, 5 * MIN);
		scheduler.stop();
		expect(clock.pending.size).toBe(0);
		await clock.advance(DAY_MS);
		expect(sent).toEqual([]);
		scheduler.stop();
		scheduler.start();
		expect(clock.pending.size).toBe(1);
	});

	test("the real timer is unref'd, so a pending task never keeps the process alive", () => {
		const db = openDb(":memory:");
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s1', 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		const s = new Scheduler(db, { session: () => ({ closed: false }), isRunning: () => false, send: async () => {} });
		s.create({ sessionId: "s1", prompt: "x", kind: "interval", everyMs: MIN * 5 });
		s.start();
		// Bun's Timeout exposes hasRef(); the test process would hang at exit if it stayed referenced.
		const timer = (s as unknown as { timer: { hasRef?: () => boolean } }).timer;
		expect(timer.hasRef?.()).toBe(false);
		s.stop();
	});
});

describe("Scheduler: busy, closed, failing", () => {
	test("a session that is running is skipped and recorded, nothing is queued; the interval goes on", async () => {
		const { scheduler, clock, sent, running } = setup({ running: ["s1"] });
		scheduler.start();
		const t = every(scheduler, 10 * MIN);
		await clock.advance(10 * MIN);
		expect(sent).toEqual([]);
		expect(scheduler.get(t.id)).toMatchObject({ lastStatus: "skipped_busy", enabled: true, nextRunAt: T0 + 20 * MIN, failCount: 0 });
		running.delete("s1");
		await clock.advance(10 * MIN);
		expect(sent.length).toBe(1);
		expect(scheduler.get(t.id).lastStatus).toBe("ok");
	});

	test("a skipped one-time task is used up (it is not retried later)", async () => {
		const { scheduler, clock, sent, running } = setup({ running: ["s1"] });
		scheduler.start();
		const t = once(scheduler, T0 + MIN);
		await clock.advance(MIN);
		running.clear();
		await clock.advance(DAY_MS);
		expect(sent).toEqual([]);
		expect(scheduler.get(t.id)).toMatchObject({ enabled: false, lastStatus: "skipped_busy" });
	});

	test("a closed session is not woken: skipped_closed, and nothing is sent", async () => {
		const { scheduler, clock, sent } = setup({ sessions: { s1: { closed: true } } });
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		await clock.advance(5 * MIN);
		expect(sent).toEqual([]);
		expect(scheduler.get(t.id)).toMatchObject({ lastStatus: "skipped_closed", enabled: true });
	});

	test("a send that fails records the error; a success resets the count", async () => {
		let boom = true;
		const { scheduler, clock, state } = setup();
		state.sendError = () => (boom ? new Error("no model") : undefined);
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		await clock.advance(10 * MIN);
		expect(scheduler.get(t.id)).toMatchObject({ lastStatus: "error", lastError: "no model", failCount: 2, enabled: true });
		boom = false;
		await clock.advance(5 * MIN);
		expect(scheduler.get(t.id)).toMatchObject({ lastStatus: "ok", lastError: null, failCount: 0 });
	});

	test(`${MAX_FAILS} failures in a row switch the task off, with no timer left`, async () => {
		const { scheduler, clock, state, sent } = setup();
		state.sendError = () => new Error("down");
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		await clock.advance(5 * MIN * (MAX_FAILS - 1));
		expect(scheduler.get(t.id)).toMatchObject({ enabled: true, failCount: MAX_FAILS - 1 });
		await clock.advance(5 * MIN);
		expect(scheduler.get(t.id)).toMatchObject({ enabled: false, nextRunAt: null, failCount: MAX_FAILS, lastStatus: "error" });
		expect(clock.pending.size).toBe(0);
		await clock.advance(DAY_MS);
		expect(sent.length).toBe(MAX_FAILS);
	});

	test("a skip between failures does not hide them: the streak survives, only a success resets it", async () => {
		const { scheduler, clock, state, running } = setup();
		state.sendError = () => new Error("down");
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		await clock.advance(10 * MIN);
		running.add("s1");
		await clock.advance(5 * MIN);
		expect(scheduler.get(t.id)).toMatchObject({ lastStatus: "skipped_busy", failCount: 2 });
	});

	test("switching a task that failed out back on starts its count again", async () => {
		const { scheduler, clock, state } = setup();
		state.sendError = () => new Error("down");
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		await clock.advance(5 * MIN * MAX_FAILS);
		expect(scheduler.get(t.id).enabled).toBe(false);
		const on = scheduler.update(t.id, { enabled: true });
		expect(on).toMatchObject({ enabled: true, failCount: 0, nextRunAt: clock.now() + 5 * MIN });
	});

	test("a send that is refused with 409 because the session started meanwhile counts as busy, not as a failure", async () => {
		const { scheduler, clock, state } = setup();
		state.sendError = () => new HttpError(409, "conflict", "busy");
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		await clock.advance(5 * MIN);
		expect(scheduler.get(t.id)).toMatchObject({ lastStatus: "skipped_busy", failCount: 0, lastError: null });
	});
});

describe("Scheduler: restart", () => {
	test("tasks missed while the server was off run once, not once per missed slot", async () => {
		const { scheduler, make, clock, sent, db } = setup();
		scheduler.start();
		const iv = every(scheduler, 10 * MIN);
		const on = once(scheduler, T0 + 30 * MIN);
		scheduler.stop();
		clock.set(T0 + 5 * 60 * MIN); // five hours later
		const restarted = make();
		restarted.start();
		expect(clock.pending.size).toBe(1);
		expect([...clock.pending.values()][0]!.ms).toBe(0);
		await clock.advance(1000);
		expect(sent.map((s) => s.text).sort()).toEqual(["hello", "tick"]);
		expect(restarted.get(iv.id)).toMatchObject({ enabled: true, nextRunAt: T0 + 5 * 60 * MIN + 10 * MIN });
		expect(restarted.get(on.id)).toMatchObject({ enabled: false, lastStatus: "ok" });
		expect((db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as { n: number }).n).toBe(2);
	});

	test("a one-time task more than 24 hours late is switched off, recorded as expired, and not sent", async () => {
		const { scheduler, make, clock, sent } = setup();
		scheduler.start();
		const late = once(scheduler, T0 + MIN);
		const ok = once(scheduler, T0 + MIN + DAY_MS, { prompt: "later" });
		scheduler.stop();
		clock.set(T0 + MIN + EXPIRE_AFTER_MS + 1);
		const restarted = make();
		restarted.start();
		await clock.advance(1000);
		expect(restarted.get(late.id)).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: "skipped_expired" });
		expect(sent.map((s) => s.text)).toEqual(["later"]); // 1ms late: well inside the day
		expect(restarted.get(ok.id).lastStatus).toBe("ok");
	});

	test("exactly 24 hours late still runs", async () => {
		const { scheduler, make, clock, sent } = setup();
		scheduler.start();
		once(scheduler, T0 + MIN);
		scheduler.stop();
		clock.set(T0 + MIN + EXPIRE_AFTER_MS);
		make().start();
		await clock.advance(1000);
		expect(sent.length).toBe(1);
	});

	test("a missed interval task is never expired, however long the server was off", async () => {
		const { scheduler, make, clock, sent } = setup();
		scheduler.start();
		every(scheduler, 5 * MIN);
		scheduler.stop();
		clock.set(T0 + 90 * DAY_MS);
		make().start();
		await clock.advance(1000);
		expect(sent.length).toBe(1);
	});

	test("disabled tasks stay off after a restart", async () => {
		const { scheduler, make, clock, sent } = setup();
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		scheduler.update(t.id, { enabled: false });
		scheduler.stop();
		clock.set(T0 + DAY_MS);
		const restarted = make();
		restarted.start();
		expect(clock.pending.size).toBe(0);
		await clock.advance(DAY_MS);
		expect(sent).toEqual([]);
	});
});

describe("Scheduler: limits (400)", () => {
	test("prompt: empty, blank and 8001 characters are refused; 1 and 8000 are fine", () => {
		const { scheduler } = setup();
		const at = T0 + MIN;
		expect(fails(() => once(scheduler, at, { prompt: "" }))).toBe(400);
		expect(fails(() => once(scheduler, at, { prompt: "  \n " }))).toBe(400);
		expect(fails(() => once(scheduler, at, { prompt: "x".repeat(MAX_PROMPT + 1) }))).toBe(400);
		expect(fails(() => once(scheduler, at, { prompt: "x" }))).toBe(0);
		expect(fails(() => once(scheduler, at, { prompt: "x".repeat(MAX_PROMPT) }))).toBe(0);
	});

	test("interval: 0, negative, 5 minutes minus 1 ms and 30 days plus 1 ms are refused; the two limits are fine", () => {
		const { scheduler } = setup();
		for (const bad of [0, -1, MIN_EVERY_MS - 1, MAX_EVERY_MS + 1]) expect(fails(() => every(scheduler, bad)), String(bad)).toBe(400);
		expect(fails(() => scheduler.create({ sessionId: "s1", prompt: "x", kind: "interval" }))).toBe(400);
		expect(fails(() => scheduler.create({ sessionId: "s1", prompt: "x", kind: "interval", everyMs: null }))).toBe(400);
		expect(fails(() => every(scheduler, MIN_EVERY_MS))).toBe(0);
		expect(fails(() => every(scheduler, MAX_EVERY_MS))).toBe(0);
	});

	test("one-time: a missing, null, 0, past or present runAt is refused; one ms ahead is fine", () => {
		const { scheduler } = setup();
		for (const bad of [undefined, null, 0, T0 - 1, T0]) expect(fails(() => scheduler.create({ sessionId: "s1", prompt: "x", kind: "once", runAt: bad as number })), String(bad)).toBe(400);
		expect(fails(() => once(scheduler, T0 + 1))).toBe(0);
	});

	test("a kind may not carry the other kind's field", () => {
		const { scheduler } = setup();
		expect(fails(() => once(scheduler, T0 + MIN, { everyMs: MIN_EVERY_MS }))).toBe(400);
		expect(fails(() => every(scheduler, MIN_EVERY_MS, { runAt: T0 + MIN }))).toBe(400);
		expect(fails(() => once(scheduler, T0 + MIN, { everyMs: null }))).toBe(0);
	});

	test("title: null and empty become no title; 100 characters fit, 101 do not", () => {
		const { scheduler } = setup();
		expect(once(scheduler, T0 + MIN, { title: null }).title).toBeNull();
		expect(once(scheduler, T0 + MIN, { title: "   " }).title).toBeNull();
		expect(once(scheduler, T0 + MIN, { title: " Daily " }).title).toBe("Daily");
		expect(fails(() => once(scheduler, T0 + MIN, { title: "x".repeat(100) }))).toBe(0);
		expect(fails(() => once(scheduler, T0 + MIN, { title: "x".repeat(101) }))).toBe(400);
	});

	test(`at most ${MAX_TASKS} tasks in all`, () => {
		const { scheduler } = setup();
		for (let i = 0; i < MAX_TASKS; i++) every(scheduler, MIN_EVERY_MS);
		expect(fails(() => every(scheduler, MIN_EVERY_MS))).toBe(400);
		expect(scheduler.list().length).toBe(MAX_TASKS);
		scheduler.delete(scheduler.list()[0]!.id);
		expect(fails(() => every(scheduler, MIN_EVERY_MS))).toBe(0);
	});

	test("an unknown session is a 404; an unknown task is a 404", async () => {
		const { scheduler } = setup();
		expect(fails(() => scheduler.create({ sessionId: "nope", prompt: "x", kind: "interval", everyMs: MIN_EVERY_MS }))).toBe(404);
		expect(fails(() => scheduler.get("nope"))).toBe(404);
		expect(fails(() => scheduler.update("nope", {}))).toBe(404);
		expect(fails(() => scheduler.delete("nope"))).toBe(404);
		expect(await scheduler.runNow("nope").catch(status)).toBe(404);
	});

	test("a closed session may still get a schedule (it is skipped until the session is resumed)", () => {
		const { scheduler } = setup({ sessions: { s1: { closed: true } } });
		expect(fails(() => every(scheduler, MIN_EVERY_MS))).toBe(0);
	});
});

describe("Scheduler: changing a task", () => {
	test("editing prompt and title keeps the schedule; changing the interval re-times it from now", () => {
		const { scheduler, clock } = setup();
		scheduler.start();
		const t = every(scheduler, 10 * MIN);
		clock.set(T0 + 3 * MIN);
		expect(scheduler.update(t.id, { prompt: "new", title: "T" })).toMatchObject({ prompt: "new", title: "T", nextRunAt: T0 + 10 * MIN });
		expect(scheduler.update(t.id, { everyMs: 20 * MIN })).toMatchObject({ everyMs: 20 * MIN, nextRunAt: T0 + 23 * MIN });
		expect([...clock.pending.values()][0]!.ms).toBe(20 * MIN); // the timer follows
	});

	test("an edit is checked like a create: empty prompt, bad interval, past runAt, wrong kind", () => {
		const { scheduler } = setup();
		const iv = every(scheduler, 10 * MIN);
		const on = once(scheduler, T0 + MIN);
		expect(fails(() => scheduler.update(iv.id, { prompt: "" }))).toBe(400);
		expect(fails(() => scheduler.update(iv.id, { everyMs: 0 }))).toBe(400);
		expect(fails(() => scheduler.update(iv.id, { everyMs: null }))).toBe(400);
		expect(fails(() => scheduler.update(iv.id, { runAt: T0 + MIN }))).toBe(400);
		expect(fails(() => scheduler.update(on.id, { runAt: T0 }))).toBe(400);
		expect(fails(() => scheduler.update(on.id, { everyMs: MIN_EVERY_MS }))).toBe(400);
		expect(scheduler.get(iv.id).prompt).toBe("tick"); // nothing half-applied
	});

	test("switching off removes the next time and the timer; switching on sets now + every_ms", () => {
		const { scheduler, clock } = setup();
		scheduler.start();
		const t = every(scheduler, 10 * MIN);
		expect(scheduler.update(t.id, { enabled: false })).toMatchObject({ enabled: false, nextRunAt: null });
		expect(clock.pending.size).toBe(0);
		clock.set(T0 + 7 * MIN);
		expect(scheduler.update(t.id, { enabled: true })).toMatchObject({ enabled: true, nextRunAt: T0 + 17 * MIN });
		expect(clock.pending.size).toBe(1);
	});

	test("a used-up one-time task cannot be switched on without a new time; with one it can", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		const t = once(scheduler, T0 + MIN);
		await clock.advance(MIN);
		expect(fails(() => scheduler.update(t.id, { enabled: true }))).toBe(400);
		const again = scheduler.update(t.id, { enabled: true, runAt: clock.now() + MIN });
		expect(again).toMatchObject({ enabled: true, nextRunAt: clock.now() + MIN });
		await clock.advance(MIN);
		expect(sent.length).toBe(2);
	});

	test("deleting the task that is due next re-arms the timer for the next one, or none", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		const a = every(scheduler, 10 * MIN);
		const b = every(scheduler, 30 * MIN, { prompt: "b" });
		scheduler.delete(a.id);
		expect([...clock.pending.values()][0]!.ms).toBe(30 * MIN);
		scheduler.delete(b.id);
		expect(clock.pending.size).toBe(0);
		await clock.advance(DAY_MS);
		expect(sent).toEqual([]);
	});

	test("every change tells the clients", () => {
		const { scheduler, changes } = setup();
		const t = every(scheduler, 10 * MIN);
		scheduler.update(t.id, { prompt: "x" });
		scheduler.delete(t.id);
		expect(changes).toEqual(["created", "updated", "deleted"]);
	});

	test("a failing onChange listener does not break the scheduler", () => {
		const db = openDb(":memory:");
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s1', 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		const s = new Scheduler(db, { session: () => ({ closed: false }), isRunning: () => false, send: async () => {} }, { onChange: () => { throw new Error("x"); } });
		expect(() => s.create({ sessionId: "s1", prompt: "x", kind: "interval", everyMs: MIN_EVERY_MS })).not.toThrow();
	});
});

describe("Scheduler: while a prompt is being sent", () => {
	/** A send that stays open until released, so the test can change the task in the middle of it. */
	function held() {
		const ctx = setup();
		let release!: () => void;
		ctx.state.hold = new Promise<void>((r) => { release = r; });
		return { ...ctx, release };
	}

	test("deleting the task mid-send leaves it deleted (the result is not written back)", async () => {
		const { scheduler, clock, sent, release, db } = held();
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		const run = clock.advance(5 * MIN);
		await Promise.resolve();
		await Promise.resolve();
		expect(sent.length).toBe(1);
		scheduler.delete(t.id);
		release();
		await run;
		expect(scheduler.find(t.id)).toBeUndefined();
		expect((db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as { n: number }).n).toBe(0);
		expect(clock.pending.size).toBe(0);
	});

	test("editing the prompt mid-send keeps the edit and still records the result", async () => {
		const { scheduler, clock, release } = held();
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		const run = clock.advance(5 * MIN);
		await Promise.resolve();
		await Promise.resolve();
		scheduler.update(t.id, { prompt: "edited", title: "mid" });
		release();
		await run;
		expect(scheduler.get(t.id)).toMatchObject({ prompt: "edited", title: "mid", lastStatus: "ok", enabled: true });
	});

	test("switching the task off mid-send keeps it off", async () => {
		const { scheduler, clock, release } = held();
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		const run = clock.advance(5 * MIN);
		await Promise.resolve();
		await Promise.resolve();
		scheduler.update(t.id, { enabled: false });
		release();
		await run;
		expect(scheduler.get(t.id)).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: "ok" });
		expect(clock.pending.size).toBe(0);
	});

	test("a send that never settles does not stop the others from being armed; run-now on it is refused with 409", async () => {
		const { scheduler, clock, sent } = held(); // never released
		scheduler.start();
		const t = every(scheduler, 5 * MIN);
		void clock.advance(5 * MIN);
		await Promise.resolve();
		await Promise.resolve();
		expect(sent.length).toBe(1);
		expect(await scheduler.runNow(t.id).catch(status)).toBe(409);
		expect(sent.length).toBe(1);
	});

	test("a run now does not move an interval's rhythm; it does use up a one-time task", async () => {
		const { scheduler, clock, sent } = setup();
		scheduler.start();
		const iv = every(scheduler, 10 * MIN);
		const on = once(scheduler, T0 + 60 * MIN);
		clock.set(T0 + 2 * MIN);
		const r = await scheduler.runNow(iv.id);
		expect(r).toMatchObject({ lastStatus: "ok", nextRunAt: T0 + 10 * MIN, enabled: true });
		const r2 = await scheduler.runNow(on.id);
		expect(r2).toMatchObject({ lastStatus: "ok", enabled: false, nextRunAt: null });
		expect(sent.length).toBe(2);
	});

	test("run now on a busy or closed session is a 409 and records nothing", async () => {
		const { scheduler, running, sessions, sent } = setup();
		const t = every(scheduler, 10 * MIN);
		running.add("s1");
		expect(await scheduler.runNow(t.id).catch(status)).toBe(409);
		running.clear();
		sessions.s1!.closed = true;
		expect(await scheduler.runNow(t.id).catch(status)).toBe(409);
		expect(sent).toEqual([]);
		expect(scheduler.get(t.id).lastStatus).toBeNull();
	});
});

describe("Scheduler: sessions going away", () => {
	test("deleting a session deletes its tasks and keeps the others", () => {
		const { scheduler, db, changes } = setup({ sessions: { s1: { closed: false }, s2: { closed: false } } });
		scheduler.create({ sessionId: "s1", prompt: "a", kind: "interval", everyMs: MIN_EVERY_MS });
		scheduler.create({ sessionId: "s1", prompt: "b", kind: "interval", everyMs: MIN_EVERY_MS });
		const keep = scheduler.create({ sessionId: "s2", prompt: "c", kind: "interval", everyMs: MIN_EVERY_MS });
		db.query("DELETE FROM sessions WHERE id = 's1'").run(); // the foreign key alone does it
		expect(scheduler.list().map((t) => t.id)).toEqual([keep.id]);
		scheduler.onSessionDeleted("s1");
		expect(changes.at(-1)).toBe("deleted");
	});

	test("the timer follows: a deleted session's task never fires", async () => {
		const { scheduler, db, clock, sent } = setup();
		scheduler.start();
		every(scheduler, 5 * MIN);
		db.query("DELETE FROM sessions WHERE id = 's1'").run();
		scheduler.onSessionDeleted("s1");
		expect(clock.pending.size).toBe(0);
		await clock.advance(DAY_MS);
		expect(sent).toEqual([]);
	});

	test("a task whose session vanished without the row going is removed when it falls due", async () => {
		const { scheduler, sessions, clock, sent, db } = setup();
		scheduler.start();
		every(scheduler, 5 * MIN);
		delete sessions.s1;
		await clock.advance(5 * MIN);
		expect(sent).toEqual([]);
		expect((db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as { n: number }).n).toBe(0);
	});

	test("a session that is closed and resumed gets its prompts again", async () => {
		const { scheduler, sessions, clock, sent } = setup();
		scheduler.start();
		every(scheduler, 5 * MIN);
		sessions.s1!.closed = true;
		await clock.advance(5 * MIN);
		sessions.s1!.closed = false;
		await clock.advance(5 * MIN);
		expect(sent.length).toBe(1);
	});
});

describe("schedule routes", () => {
	let app: App;
	let dir: string;
	let upstream: EchoUpstream;
	const api = async (method: any, url: string, payload?: unknown) => {
		const res = await app.server.inject({
			method, url,
			headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
			...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
		});
		return { status: res.statusCode, json: res.body ? res.json() : undefined };
	};
	const newSession = async () => {
		const res = await api("POST", "/sessions", {});
		expect(res.status).toBe(201);
		return res.json.id as string;
	};
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-schedule-"));
		const ws = join(dir, "ws");
		mkdirSync(ws);
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		upstream = startEchoUpstream();
		app = await buildApp(cfg, { strictResponses: true });
		await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
		await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	});
	afterAll(async () => {
		await app.close();
		upstream.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("create, list (with the sessionId filter), patch, delete", async () => {
		const a = await newSession();
		const b = await newSession();
		const made = await api("POST", "/schedules", { sessionId: a, prompt: "status?", kind: "interval", everyMs: 10 * MIN, title: "Check" });
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ sessionId: a, title: "Check", kind: "interval", enabled: true, lastStatus: null, failCount: 0 });
		await api("POST", "/schedules", { sessionId: b, prompt: "other", kind: "once", runAt: Date.now() + DAY_MS });
		expect((await api("GET", "/schedules")).json.schedules.length).toBe(2);
		expect((await api("GET", `/schedules?sessionId=${a}`)).json.schedules.map((s: any) => s.id)).toEqual([made.json.id]);
		const patched = await api("PATCH", `/schedules/${made.json.id}`, { enabled: false, prompt: "new" });
		expect(patched.json).toMatchObject({ enabled: false, nextRunAt: null, prompt: "new" });
		expect((await api("DELETE", `/schedules/${made.json.id}`)).json).toEqual({ ok: true });
		expect((await api("DELETE", `/schedules/${made.json.id}`)).status).toBe(404);
		expect((await api("PATCH", `/schedules/${made.json.id}`, { enabled: true })).status).toBe(404);
	});

	test("limit violations are 400, an unknown session 404, a missing token 401", async () => {
		const s = await newSession();
		const post = (body: object) => api("POST", "/schedules", { sessionId: s, ...body });
		expect((await post({ prompt: "", kind: "interval", everyMs: 10 * MIN })).status).toBe(400);
		expect((await post({ prompt: "x".repeat(MAX_PROMPT + 1), kind: "interval", everyMs: 10 * MIN })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "interval", everyMs: 0 })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "interval", everyMs: MIN })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "interval", everyMs: MAX_EVERY_MS + 1 })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "interval", everyMs: null })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "interval" })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "interval", everyMs: 1.5 * MIN_EVERY_MS + 0.5 })).status).toBe(400); // not an integer
		expect((await post({ prompt: "x", kind: "once", runAt: null })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "once", runAt: 1 })).status).toBe(400);
		expect((await post({ prompt: "x", kind: "weekly" })).status).toBe(400);
		expect((await post({ prompt: null, kind: "once", runAt: Date.now() + DAY_MS })).status).toBe(400);
		expect((await api("POST", "/schedules", { sessionId: "nope", prompt: "x", kind: "interval", everyMs: 10 * MIN })).status).toBe(404);
		const res = await app.server.inject({ method: "GET", url: "/schedules" });
		expect(res.statusCode).toBe(401);
	});

	test(`the ${MAX_TASKS}-task limit is a 400`, async () => {
		const s = await newSession();
		const have = (await api("GET", "/schedules")).json.schedules.length as number;
		for (let i = have; i < MAX_TASKS; i++) expect((await api("POST", "/schedules", { sessionId: s, prompt: "x", kind: "interval", everyMs: 10 * MIN })).status).toBe(201);
		expect((await api("POST", "/schedules", { sessionId: s, prompt: "x", kind: "interval", everyMs: 10 * MIN })).status).toBe(400);
		for (const t of (await api("GET", "/schedules")).json.schedules) await api("DELETE", `/schedules/${t.id}`);
	});

	test("deleting a session through the API removes its schedules", async () => {
		const s = await newSession();
		await api("POST", "/schedules", { sessionId: s, prompt: "x", kind: "interval", everyMs: 10 * MIN });
		expect((await api("GET", `/schedules?sessionId=${s}`)).json.schedules.length).toBe(1);
		expect((await api("DELETE", `/sessions/${s}`)).status).toBe(204);
		expect((await api("GET", `/schedules?sessionId=${s}`)).json.schedules).toEqual([]);
	});

	test("run now on a closed session is 409; every change is published as schedules_updated", async () => {
		const s = await newSession();
		const events: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.type === "schedules_updated") events.push(e.data); });
		const made = await api("POST", "/schedules", { sessionId: s, prompt: "x", kind: "interval", everyMs: 10 * MIN });
		await api("PATCH", `/sessions/${s}`, { closed: true });
		expect((await api("POST", `/schedules/${made.json.id}/run`)).status).toBe(409);
		expect((await api("POST", "/schedules/nope/run")).status).toBe(404);
		await api("DELETE", `/schedules/${made.json.id}`);
		off();
		expect(events.map((e) => e.action)).toEqual(["created", "deleted"]);
		expect(events[0].id).toBe(made.json.id);
	});

	test("run now sends the prompt as a schedule run: run_started/run_finished carry the origin, the message carries the schedule block", async () => {
		const s = await newSession();
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.sessionId === s && (e.type === "run_started" || e.type === "run_finished")) seen.push(e); });
		const made = await api("POST", "/schedules", { sessionId: s, prompt: "ping from schedule", kind: "interval", everyMs: 10 * MIN });
		const ran = await api("POST", `/schedules/${made.json.id}/run`);
		expect(ran.status).toBe(200);
		expect(ran.json).toMatchObject({ lastStatus: "ok", failCount: 0, enabled: true });
		for (let i = 0; i < 100 && !seen.some((e) => e.type === "run_finished"); i++) await Bun.sleep(20);
		off();
		expect(seen.map((e) => [e.type, e.data.origin])).toEqual([["run_started", "schedule"], ["run_finished", "schedule"]]);
		const msgs = (await api("GET", `/sessions/${s}/messages`)).json;
		const first = JSON.stringify(msgs.messages?.[0] ?? msgs);
		expect(first).toContain("ping from schedule");
		expect(first).toContain("<pipaya-schedule>");
	});

	test("the event is listed in /events/types", async () => {
		const types = (await api("GET", "/events/types")).json.events.map((e: any) => e.type);
		expect(types).toContain("schedules_updated");
	});
});

describe("migration", () => {
	test("the table exists with the agreed columns, and a session's rows cascade", () => {
		const db = openDb(":memory:");
		const cols = (db.query("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[]).map((c) => c.name).sort();
		expect(cols).toEqual(["created_at", "enabled", "every_ms", "fail_count", "id", "kind", "last_error", "last_run_at", "last_status", "next_run_at", "prompt", "run_at", "session_id", "title", "updated_at"]);
		expect(() => db.query("INSERT INTO scheduled_tasks (id, session_id, prompt, kind, created_at, updated_at) VALUES ('x', 'missing', 'p', 'once', 1, 1)").run()).toThrow(); // foreign key
		expect(() => db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s', 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run()).not.toThrow();
		expect(() => db.query("INSERT INTO scheduled_tasks (id, session_id, prompt, kind, created_at, updated_at) VALUES ('x', 's', 'p', 'weekly', 1, 1)").run()).toThrow(); // kind check
		db.query("INSERT INTO scheduled_tasks (id, session_id, prompt, kind, created_at, updated_at) VALUES ('x', 's', 'p', 'once', 1, 1)").run();
		db.query("DELETE FROM sessions WHERE id = 's'").run();
		expect(db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get()).toEqual({ n: 0 });
	});
});
