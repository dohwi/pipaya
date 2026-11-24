import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { FileIndexCache, rank, type Indexed } from "../src/routes/fs-routes.ts";
import { HISTORY_KEEP_MS, PRUNE_INTERVAL_MS, Scheduler, type SchedulerHost, type Timers } from "../src/scheduler.ts";
import { SessionStore, type SessionRecord } from "../src/store.ts";

const makeSession = (id: string, cwd = "/tmp/work", now = 1000): SessionRecord => ({
	id,
	title: "t",
	name: id,
	purpose: "",
	cwd,
	provider: "p",
	model: "m",
	thinkingLevel: "medium",
	systemPrompt: "",
	tools: [],
	parentId: null,
	closed: false,
	createdAt: now,
	updatedAt: now,
});

describe("SQLite hot-path indexes & query plans", () => {
	test("EXPLAIN QUERY PLAN uses the new indexes for events prune, usage, workdirs and extension_entries", () => {
		const db = openDb(":memory:");
		const plan = (sql: string) =>
			(db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");

		expect(plan("DELETE FROM events WHERE ts < 100")).toContain("idx_events_ts");
		expect(plan("SELECT COUNT(*) FROM messages WHERE session_id = 's' AND role = 'toolResult'")).toContain("idx_messages_session_role_seq");
		expect(plan("SELECT cwd, COUNT(*) FROM sessions GROUP BY cwd")).toContain("idx_sessions_cwd");
		expect(plan("SELECT id FROM extension_entries WHERE session_id = 's' AND id > 0 ORDER BY id LIMIT 10")).toContain("idx_extension_entries_session_id");
	});
});

describe("SessionStore transactional writes & usage pre-filter", () => {
	test("appendMessage and replaceMessage update messages and session updated_at atomically", () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		store.create(makeSession("s1", "/work", 100));

		const msg1 = { role: "user", content: "hello", timestamp: 1 } as AgentMessage;
		store.appendMessage("s1", 0, msg1);
		const afterAppend = store.get("s1")!.updatedAt;
		expect(afterAppend).toBeGreaterThan(100);
		expect(store.messages("s1")).toHaveLength(1);

		// Duplicate (session_id, seq) fails inside the transaction and does not touch updated_at.
		db.query("UPDATE sessions SET updated_at = 200 WHERE id = 's1'").run();
		expect(() => store.appendMessage("s1", 0, msg1)).toThrow();
		expect(store.get("s1")!.updatedAt).toBe(200);

		const msg1Updated = { role: "user", content: "edited", timestamp: 2 } as AgentMessage;
		store.replaceMessage("s1", 0, msg1Updated);
		expect(store.get("s1")!.updatedAt).toBeGreaterThan(200);
		expect((store.messages("s1")[0]!.message as { content: string }).content).toBe("edited");
	});

	test("usage() sums assistant + delegate toolResult usage while skipping non-delegate toolResults", () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		store.create(makeSession("s1"));

		store.appendMessage("s1", 0, {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.01 } },
			timestamp: 1,
		} as unknown as AgentMessage);

		// Non-delegate toolResult that happens to carry a details.usage object must NOT be counted.
		store.appendMessage("s1", 1, {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			details: { usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998, cost: 9.99 } },
			isError: false,
			timestamp: 2,
		} as unknown as AgentMessage);

		// Delegate toolResult MUST be counted.
		store.appendMessage("s1", 2, {
			role: "toolResult",
			toolCallId: "t2",
			toolName: "delegate",
			content: [{ type: "text", text: "subagent answer" }],
			details: { usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, totalTokens: 33, cost: 0.002 } },
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage);

		const totals = store.usage("s1");
		expect(totals.turns).toBe(1);
		expect(totals.input).toBe(120);
		expect(totals.output).toBe(60);
		expect(totals.cacheRead).toBe(12);
		expect(totals.cacheWrite).toBe(6);
		expect(totals.totalTokens).toBe(198);
		expect(totals.cost).toBeCloseTo(0.012, 6);
	});
});

describe("Scheduler.list() throttled pruning", () => {
	test("list() avoids write-lock prune inside the throttle window while still hiding expired history", async () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		store.create(makeSession("s1"));

		let now = 1_700_000_000_000;
		const host: SchedulerHost = {
			session: (id) => (id === "s1" ? { closed: false } : undefined),
			isRunning: () => false,
			send: async () => {},
		};
		const timers: Timers = { set: () => 1, clear: () => {} };
		const scheduler = new Scheduler(db, host, { now: () => now, timers });
		scheduler.start();

		const task = scheduler.create({ sessionId: "s1", prompt: "once", kind: "once", runAt: now + 60_000 });
		now += 60_000;
		await scheduler.tick();
		expect(scheduler.get(task.id).lastStatus).toBe("ok");

		// Jump to exactly HISTORY_KEEP_MS: triggers one throttled prune, task still kept.
		now += HISTORY_KEEP_MS;
		expect(scheduler.list().map((t) => t.id)).toContain(task.id);

		// 1ms later (well inside PRUNE_INTERVAL_MS): list() hides the expired row without physically deleting it yet.
		now += 1;
		expect(scheduler.list().map((t) => t.id)).toEqual([]);
		expect(scheduler.find(task.id)).toBeDefined();

		// Once PRUNE_INTERVAL_MS passes, list() runs prune() and deletes the row from SQLite.
		now += PRUNE_INTERVAL_MS;
		expect(scheduler.list().map((t) => t.id)).toEqual([]);
		expect(scheduler.find(task.id)).toBeUndefined();
		scheduler.stop();
	});
});

describe("fs-routes ranking & FileIndexCache", () => {
	const item = (path: string, dir: boolean): Indexed => {
		const lower = path.toLowerCase();
		const trimmed = dir ? lower.slice(0, -1) : lower;
		const slash = trimmed.lastIndexOf("/");
		return {
			path,
			dir,
			lower,
			name: slash === -1 ? trimmed : trimmed.slice(slash + 1),
			depth: lower.split("/").length,
		};
	};

	test("rank() uses precomputed name and depth accurately across all match tiers", () => {
		const rootFile = item("README.md", false);
		const rootDir = item("src/", true);
		const nestedFile = item("src/components/Composer.svelte", false);

		// Empty query: shallow first
		expect(rank(rootFile, "")).toBe(0);
		expect(rank(rootDir, "")).toBe(0.5);
		expect(rank(nestedFile, "")).toBe(2);

		// Query match tiers
		expect(rank(rootDir, "src")).toBe(0); // exact match (with trailing /)
		expect(rank(nestedFile, "src/comp")).toBe(1); // path prefix
		expect(rank(nestedFile, "composer")).toBe(2); // basename prefix
		expect(rank(nestedFile, "poser")).toBe(3); // basename substring
		expect(rank(nestedFile, "ents/comp")).toBe(4); // path substring
		expect(rank(nestedFile, "cmps")).toBe(5); // subsequence
		expect(rank(nestedFile, "zzzz")).toBe(99); // no match
	});

	test("FileIndexCache evicts expired entries before LRU and preserves recently accessed active roots", async () => {
		let now = 1000;
		const cache = new FileIndexCache<string[]>(5000, 3, () => now);
		const p = (v: string) => Promise.resolve([v]);

		const pa = cache.set("/a", p("a"));
		await pa;
		now = 2000;
		const pb = cache.set("/b", p("b"));
		await pb;
		now = 3000;
		const pc = cache.set("/c", p("c"));
		await pc;

		// Access /a to refresh its LRU position; now /b is least recently used.
		now = 3500;
		expect(cache.get("/a")).toBe(pa);

		// Inserting /d evicts /b (LRU), keeping /a and /c (no stampede clear).
		const pd = cache.set("/d", p("d"));
		await pd;
		expect(cache.size).toBe(3);
		expect(cache.has("/b")).toBe(false);
		expect(cache.has("/a")).toBe(true);
		expect(cache.has("/c")).toBe(true);
		expect(cache.has("/d")).toBe(true);

		// Advance time so /a (at=1000) expires while /c (at=3000) and /d (at=3500) are still fresh.
		now = 6500;
		const pe = cache.set("/e", p("e"));
		await pe;
		expect(cache.size).toBe(3);
		expect(cache.has("/a")).toBe(false);
		expect(cache.has("/c")).toBe(true);
		expect(cache.has("/d")).toBe(true);
		expect(cache.has("/e")).toBe(true);
	});

	test("GET /fs/dirs lists subdirectories asynchronously, follows dir symlinks, and skips broken symlinks", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-fs-dirs-")));
		const target = join(dir, "real-target");
		const root = join(dir, "browse");
		mkdirSync(target, { recursive: true });
		mkdirSync(join(root, "alpha"), { recursive: true });
		mkdirSync(join(root, ".hidden"), { recursive: true });
		writeFileSync(join(root, "plain.txt"), "hi");
		symlinkSync(target, join(root, "link-dir"));
		symlinkSync(join(dir, "does-not-exist"), join(root, "broken-link"));

		const token = "fs-dirs-async-test-token-0123456789";
		const app = await buildApp({ host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token, workspaceRoot: dir, logLevel: "silent" });
		try {
			const res = await app.server.inject({ method: "GET", url: `/fs/dirs?path=${encodeURIComponent(root)}`, headers: { authorization: `Bearer ${token}` } });
			expect(res.statusCode).toBe(200);
			const body = res.json() as { entries: { name: string }[]; truncated: boolean };
			expect(body.entries.map((e) => e.name)).toEqual(["alpha", "link-dir"]);
			expect(body.truncated).toBe(false);

			const withHidden = await app.server.inject({ method: "GET", url: `/fs/dirs?path=${encodeURIComponent(root)}&hidden=true`, headers: { authorization: `Bearer ${token}` } });
			expect((withHidden.json() as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual([".hidden", "alpha", "link-dir"]);
		} finally {
			await app.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("WebSocket replay buffer cap & multi-client broadcast", () => {
	test("closes a replaying socket with 1013 when live events overflow maxReplayBuffer and releases its subscription", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-ws-buf-"));
		const token = "ws-buf-test-token-0123456789abcdef";
		const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token, workspaceRoot: dir, logLevel: "silent" };
		const app = await buildApp(cfg, { websocket: { maxReplayBuffer: 3 } });
		try {
			const addr = await app.server.listen({ host: "0.0.0.0", port: 0 });
			const port = Number(new URL(addr).port);
			// Seed >500 events so async replay yields on setImmediate while replaying = true.
			const first = app.bus.publish(null, "ping", { n: 0 }).id;
			for (let i = 1; i <= 600; i++) app.bus.publish(null, "ping", { n: i });

			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
			await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
			const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
				ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }), { once: true });
			});

			const beforeSubs = app.bus.subscriberCount;
			ws.send(JSON.stringify({ id: 1, op: "subscribe", after: first - 1 }));
			// Wait until the subscription is registered, then burst live events while replay is yielded.
			for (let i = 0; i < 50 && app.bus.subscriberCount === beforeSubs; i++) await Bun.sleep(1);
			for (let i = 0; i < 10; i++) app.bus.publish(null, "ping", { live: i }, { ephemeral: true });

			const closed = await closePromise;
			expect(closed.code).toBe(1013);
			expect(closed.reason).toBe("replay buffer overflow");
			for (let i = 0; i < 50 && app.bus.subscriberCount !== beforeSubs; i++) await Bun.sleep(10);
			expect(app.bus.subscriberCount).toBe(beforeSubs);
		} finally {
			await app.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
