import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { HttpError } from "../src/errors.ts";
import { CONTINUATION_PROMPT, GoalManager, type GoalHost, type GoalTimers } from "../src/goals.ts";
import { MAX_GOAL_OBJECTIVE } from "../src/shared/goals.ts";

const T0 = 1_700_000_000_000;

function fakeClock() {
	let now = T0;
	let seq = 0;
	const pending = new Map<number, { at: number; fn: () => void }>();
	const timers: GoalTimers = {
		set: (fn, ms) => {
			const id = ++seq;
			pending.set(id, { at: now + ms, fn });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clear: (h) => {
			pending.delete(h as unknown as number);
		},
	};
	return {
		now: () => now,
		timers,
		pending,
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				pending.delete(next[0]);
				now = Math.max(now, next[1].at);
				next[1].fn();
			}
			now = end;
		},
	};
}

function setup(opts: { sessions?: Record<string, { closed: boolean }>; running?: string[] } = {}) {
	const db = openDb(":memory:");
	const clock = fakeClock();
	const sessions: Record<string, { id: string; closed: boolean }> = {};
	for (const [id, v] of Object.entries(opts.sessions ?? { s1: { closed: false } })) {
		sessions[id] = { id, closed: v.closed };
		db.query(
			"INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES (?, 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, ?, '')",
		).run(id, v.closed ? 1 : 0);
	}
	const running = new Set(opts.running ?? []);
	const tokens = new Map<string, number>();
	const sent: { id: string; text: string; origin: string }[] = [];
	const steered: { id: string; text: string }[] = [];
	const changes: { sessionId: string; action: string }[] = [];
	const host: GoalHost = {
		session: (id) => sessions[id],
		isRunning: (id) => running.has(id),
		tokens: (id) => tokens.get(id) ?? 0,
		send: async (id, input) => {
			sent.push({ id, text: input.text, origin: input.origin });
		},
		steer: (id, text) => {
			if (!running.has(id)) return false;
			steered.push({ id, text });
			return true;
		},
	};
	const goals = new GoalManager(db, host, {
		now: clock.now,
		timers: clock.timers,
		continueDelayMs: 250,
		onChange: (c) => changes.push(c),
	});
	return { db, clock, sessions, running, tokens, sent, steered, changes, goals };
}

describe("GoalManager", () => {
	test("validates objective and tokenBudget, and rejects unknown sessions", () => {
		const { goals } = setup();
		expect(() => goals.put("missing", { objective: "do work" })).toThrow(HttpError);
		expect(() => goals.put("s1", { objective: "   " })).toThrow(HttpError);
		expect(() => goals.put("s1", { objective: "a".repeat(MAX_GOAL_OBJECTIVE + 1) })).toThrow(HttpError);
		expect(() => goals.put("s1", { objective: "ok", tokenBudget: 0 })).toThrow(HttpError);
		expect(() => goals.put("s1", { objective: "ok", tokenBudget: -10 })).toThrow(HttpError);
	});

	test("putting an active goal schedules continuation when idle; editing preserves usage and replacing resets it", () => {
		const { goals, clock, tokens, sent, running } = setup();
		const created = goals.put("s1", { objective: "Ship tests", tokenBudget: null });
		expect(created.status).toBe("active");
		expect(created.tokenBudget).toBeNull();
		expect(created.tokensUsed).toBe(0);

		clock.advance(300);
		expect(sent).toEqual([{ id: "s1", text: CONTINUATION_PROMPT, origin: "goal" }]);

		// Simulate a run that consumes 12_000 tokens over 15s.
		running.add("s1");
		goals.onRunStarted("s1");
		tokens.set("s1", 12_000);
		clock.advance(15_000);
		goals.onMessageEnd("s1", { role: "assistant", hasToolCalls: true });
		running.delete("s1");
		goals.onRunFinished("s1", { status: "ok", origin: "goal" });

		const after = goals.get("s1")!;
		expect(after.tokensUsed).toBe(12_000);
		expect(after.timeUsedSeconds).toBe(15);

		// In-place edit keeps usage and goalId.
		const edited = goals.put("s1", { objective: "Ship unit + e2e tests", tokenBudget: 500_000 });
		expect(edited.goalId).toBe(created.goalId);
		expect(edited.tokensUsed).toBe(12_000);
		expect(edited.tokenBudget).toBe(500_000);

		// Replace starts fresh with a new goalId and zero usage.
		const replaced = goals.put("s1", { objective: "Fresh goal", replace: true });
		expect(replaced.goalId).not.toBe(created.goalId);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
	});

	test("token budget stops mid-turn, steers wrap-up once, blocks resume until raised, and revives when raised", () => {
		const { goals, clock, tokens, running, steered, sent } = setup();
		goals.put("s1", { objective: "Refactor", tokenBudget: 10_000 });
		goals.cancelPending("s1");

		running.add("s1");
		goals.onRunStarted("s1");
		tokens.set("s1", 10_500);
		clock.advance(5_000);
		goals.onMessageEnd("s1", { role: "assistant", hasToolCalls: true });

		expect(goals.get("s1")!.status).toBe("budget_limited");
		expect(steered).toHaveLength(1);
		expect(goals.systemNote("s1")).toContain("Budget Reached");

		// Second message in the same turn does not duplicate the steering warning.
		tokens.set("s1", 11_000);
		goals.onMessageEnd("s1", { role: "assistant", textLength: 40 });
		expect(steered).toHaveLength(1);

		running.delete("s1");
		goals.onRunFinished("s1", { status: "ok", origin: "goal" });
		clock.advance(1000);
		expect(sent).toHaveLength(0);

		// Trying to resume without raising budget stays budget_limited.
		expect(goals.patch("s1", { status: "active" }).status).toBe("budget_limited");

		// Raising budget above tokensUsed automatically revives to active and schedules continuation.
		const revived = goals.patch("s1", { tokenBudget: 50_000 });
		expect(revived.status).toBe("active");
		clock.advance(300);
		expect(sent).toHaveLength(1);
	});

	test("manual abort pauses; usage limit sets usage_limited; generic error sets blocked; 3 empty turns auto-block", () => {
		const { goals, running, clock, sent } = setup();
		goals.put("s1", { objective: "Work" });
		goals.cancelPending("s1");

		// Manual stop -> paused
		running.add("s1");
		goals.onRunStarted("s1");
		running.delete("s1");
		goals.onRunFinished("s1", { status: "aborted", cause: "user", origin: "goal" });
		expect(goals.get("s1")!.status).toBe("paused");

		// Resume, then hit provider 429 -> usage_limited
		goals.patch("s1", { status: "active" });
		goals.cancelPending("s1");
		running.add("s1");
		goals.onRunStarted("s1");
		running.delete("s1");
		goals.onRunFinished("s1", { status: "error", error: "HTTP 429 rate limit exceeded", origin: "goal" });
		expect(goals.get("s1")!.status).toBe("usage_limited");

		// Resume, then hit generic error -> blocked
		goals.patch("s1", { status: "active" });
		goals.cancelPending("s1");
		running.add("s1");
		goals.onRunStarted("s1");
		running.delete("s1");
		goals.onRunFinished("s1", { status: "error", error: "upstream connection reset", origin: "goal" });
		expect(goals.get("s1")!.status).toBe("blocked");

		// Resume, then 3 empty automatic continuations -> blocked
		goals.patch("s1", { status: "active" });
		goals.cancelPending("s1");
		for (let i = 0; i < 3; i++) {
			running.add("s1");
			goals.onRunStarted("s1");
			running.delete("s1");
			goals.onRunFinished("s1", { status: "ok", origin: "goal" });
			goals.cancelPending("s1");
		}
		expect(goals.get("s1")!.status).toBe("blocked");
		clock.advance(1000);
		expect(sent).toHaveLength(0);
	});

	test("agentCreate refuses while unfinished goal exists; agentUpdate marks complete and stops continuation", () => {
		const { goals, clock, sent } = setup();
		goals.agentCreate("s1", "First objective");
		expect(() => goals.agentCreate("s1", "Second objective")).toThrow();

		const done = goals.agentUpdate("s1", "complete");
		expect(done.status).toBe("complete");
		clock.advance(1000);
		expect(sent).toHaveLength(0);

		// Once complete, agentCreate may start a new goal.
		const next = goals.agentCreate("s1", "Second objective", 250_000);
		expect(next.status).toBe("active");
		expect(next.tokenBudget).toBe(250_000);
	});

	test("closing a session pauses its active goal and cancels pending continuation", () => {
		const { goals, clock, sent, sessions } = setup();
		goals.put("s1", { objective: "Background task" });
		sessions.s1!.closed = true;
		goals.onSessionClosed("s1");
		expect(goals.get("s1")!.status).toBe("paused");
		clock.advance(1000);
		expect(sent).toHaveLength(0);
	});

	test("recoverOnBoot pauses active goals left across restart while leaving other statuses intact", () => {
		const { goals, db, sessions } = setup();
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s2', 't2', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s3', 't3', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		sessions.s2 = { id: "s2", closed: false };
		sessions.s3 = { id: "s3", closed: false };

		goals.put("s1", { objective: "Active goal" });
		goals.put("s2", { objective: "Complete goal" });
		goals.agentUpdate("s2", "complete");
		goals.put("s3", { objective: "Blocked goal" });
		goals.agentUpdate("s3", "blocked");
		goals.cancelPending("s1");

		const changed: string[] = [];
		const restarted = new GoalManager(
			db,
			{ session: (id) => sessions[id], isRunning: () => false, tokens: () => 0, send: async () => {}, steer: () => false },
			{ onChange: (c) => changed.push(`${c.sessionId}:${c.action}`) },
		);
		expect(restarted.recoverOnBoot()).toBe(1);
		expect(restarted.get("s1")!.status).toBe("paused");
		expect(restarted.get("s2")!.status).toBe("complete");
		expect(restarted.get("s3")!.status).toBe("blocked");
		expect(changed).toEqual(["s1:updated"]);
		expect(restarted.recoverOnBoot()).toBe(0);
	});
});

describe("goals HTTP routes and lifecycle", () => {
	let dir: string;
	let app: App;
	const token = "goal-test-token";
	const auth = { authorization: `Bearer ${token}` };

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-goals-"));
		const ws = join(dir, "workspace");
		mkdirSync(ws, { recursive: true });
		const cfg: Config = {
			host: "127.0.0.1",
			port: 0,
			dataDir: dir,
			dbPath: join(dir, "db.sqlite"),
			workspaceRoot: ws,
			token,
			logLevel: "silent",
		};
		app = await buildApp(cfg, { home: dir, strictResponses: true });
		await app.server.inject({
			method: "PUT",
			url: "/configuration/providers/fake",
			headers: auth,
			payload: {
				name: "fake",
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				authRequired: false,
				models: [{ id: "m1", contextWindow: 100_000, maxTokens: 4_000, reasoning: false, vision: false }],
			},
		});
	});

	afterAll(async () => {
		await app?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("PUT / PATCH / GET / DELETE /sessions/:id/goal + session deletion cascade + goals_updated events", async () => {
		const events: { type: string; data: unknown }[] = [];
		const unsub = app.bus.subscribe((e) => {
			if (e.type === "goals_updated") events.push({ type: e.type, data: e.data });
		});

		const created = await app.server.inject({ method: "POST", url: "/sessions", headers: auth, payload: { cwd: "." } });
		expect(created.statusCode).toBe(201);
		const sid = created.json().id as string;

		// Initially empty
		const list0 = await app.server.inject({ method: "GET", url: "/goals", headers: auth });
		expect(list0.statusCode).toBe(200);
		expect(list0.json().goals).toEqual([]);

		// Put goal (pause right after so no fake upstream call is attempted)
		const put = await app.server.inject({
			method: "PUT",
			url: `/sessions/${sid}/goal`,
			headers: auth,
			payload: { objective: "Fix all lint errors", tokenBudget: 500_000 },
		});
		expect(put.statusCode).toBe(200);
		expect(put.json().objective).toBe("Fix all lint errors");
		expect(put.json().tokenBudget).toBe(500_000);
		expect(put.json().status).toBe("active");

		// Patch -> paused
		const patched = await app.server.inject({
			method: "PATCH",
			url: `/sessions/${sid}/goal`,
			headers: auth,
			payload: { status: "paused", tokenBudget: null },
		});
		expect(patched.statusCode).toBe(200);
		expect(patched.json().status).toBe("paused");
		expect(patched.json().tokenBudget).toBeNull();

		// GET /goals?sessionId=...
		const list1 = await app.server.inject({ method: "GET", url: `/goals?sessionId=${sid}`, headers: auth });
		expect(list1.json().goals).toHaveLength(1);

		// DELETE /sessions/:id/goal
		const del = await app.server.inject({ method: "DELETE", url: `/sessions/${sid}/goal`, headers: auth });
		expect(del.statusCode).toBe(200);
		expect(del.json()).toEqual({ ok: true });

		const list2 = await app.server.inject({ method: "GET", url: "/goals", headers: auth });
		expect(list2.json().goals).toEqual([]);

		expect(events.map((e) => (e.data as { action: string }).action)).toEqual(["set", "updated", "cleared"]);
		unsub();
	});

	test("restarting the server pauses active goals on boot so none remain silently stalled", async () => {
		const restartDir = mkdtempSync(join(tmpdir(), "pipaya-goals-restart-"));
		const ws = join(restartDir, "workspace");
		mkdirSync(ws, { recursive: true });
		const cfg: Config = {
			host: "127.0.0.1",
			port: 0,
			dataDir: restartDir,
			dbPath: join(restartDir, "db.sqlite"),
			workspaceRoot: ws,
			token,
			logLevel: "silent",
		};
		let a1: App | undefined;
		let a2: App | undefined;
		try {
			a1 = await buildApp(cfg, { home: restartDir, strictResponses: true });
			await a1.server.inject({
				method: "PUT",
				url: "/configuration/providers/fake",
				headers: auth,
				payload: {
					name: "fake",
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					authRequired: false,
					models: [{ id: "m1", contextWindow: 100_000, maxTokens: 4_000, reasoning: false, vision: false }],
				},
			});
			const s = await a1.server.inject({ method: "POST", url: "/sessions", headers: auth, payload: { cwd: "." } });
			expect(s.statusCode).toBe(201);
			const sid = s.json().id as string;
			const put = await a1.server.inject({ method: "PUT", url: `/sessions/${sid}/goal`, headers: auth, payload: { objective: "Survive reboot cleanly" } });
			expect(put.statusCode).toBe(200);
			expect(put.json().status).toBe("active");
			await a1.close();
			a1 = undefined;

			a2 = await buildApp(cfg, { home: restartDir, strictResponses: true });
			const after = await a2.server.inject({ method: "GET", url: `/goals?sessionId=${sid}`, headers: auth });
			expect(after.statusCode).toBe(200);
			expect(after.json().goals).toHaveLength(1);
			expect(after.json().goals[0].status).toBe("paused");
		} finally {
			await a1?.close();
			await a2?.close();
			rmSync(restartDir, { recursive: true, force: true });
		}
	});
});
