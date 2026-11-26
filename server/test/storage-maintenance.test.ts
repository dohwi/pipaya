import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { convertToIncrementalAutoVacuum, maintainDb, openDb, WAL_JOURNAL_SIZE_LIMIT } from "../src/db.ts";
import { OpenRouterCatalog } from "../src/openrouter-catalog.ts";
import { Retention } from "../src/retention.ts";
import { SessionMedia } from "../src/session-media.ts";
import { SessionStore } from "../src/store.ts";
import { clearSubagentCache, loadSubagents } from "../src/subagents.ts";
import { replaceToolMessageImages, STORAGE_IMAGE_PLACEHOLDER } from "../src/tool-images.ts";

const temps: string[] = [];
function tempDir(prefix = "pipaya-storage-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	temps.push(d);
	return d;
}

afterEach(() => {
	clearSubagentCache();
	while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function pragmaInt(db: Database, name: string): number {
	const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
	const value = row ? Object.values(row)[0] : 0;
	return typeof value === "number" ? value : 0;
}

function makeLegacyDb(path: string, rowCount = 400): void {
	const legacy = new Database(path, { create: true, strict: true });
	legacy.exec("PRAGMA auto_vacuum = NONE; PRAGMA journal_mode = WAL;");
	legacy.exec("CREATE TABLE scratch (id INTEGER PRIMARY KEY, pad TEXT)");
	const ins = legacy.query("INSERT INTO scratch (pad) VALUES ($p)");
	legacy.transaction(() => {
		for (let i = 0; i < rowCount; i++) ins.run({ p: "x".repeat(4000) });
	})();
	legacy.exec("DELETE FROM scratch WHERE id > 1");
	legacy.close();
}

function makeSession(db: Database, store: SessionStore, id: string, opts: { closed?: boolean; updatedAt?: number } = {}): void {
	const now = opts.updatedAt ?? Date.now();
	store.create({
		id,
		title: id,
		name: id,
		purpose: "",
		cwd: "/tmp",
		provider: "p",
		model: "m",
		thinkingLevel: "off",
		systemPrompt: "",
		tools: [],
		parentId: null,
		closed: false,
		createdAt: now,
		updatedAt: now,
	});
	if (opts.closed) db.query("UPDATE sessions SET closed = 1 WHERE id = $id").run({ id });
}

function setUpdatedAt(db: Database, id: string, ts: number): void {
	db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ t: ts, id });
}

function toolResultWithImage(id: string, text?: string): AgentMessage {
	const content: unknown[] = [];
	if (text !== undefined) content.push({ type: "text", text });
	content.push({ type: "image", data: "AAAA".repeat(100), mimeType: "image/png" });
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		isError: false,
		timestamp: Date.now(),
		content,
	} as unknown as AgentMessage;
}

function userWithImage(text = "hi"): AgentMessage {
	return {
		role: "user",
		timestamp: Date.now(),
		content: [
			{ type: "text", text },
			{ type: "image", data: "BBBB".repeat(50), mimeType: "image/png" },
		],
	} as unknown as AgentMessage;
}

describe("SQLite openDb, convertToIncrementalAutoVacuum & maintainDb", () => {
	test("new file DB enables INCREMENTAL auto_vacuum and WAL journal_size_limit", () => {
		const path = join(tempDir(), "new.db");
		const db = openDb(path);
		try {
			expect(pragmaInt(db, "auto_vacuum")).toBe(2);
			expect(pragmaInt(db, "journal_size_limit")).toBe(WAL_JOURNAL_SIZE_LIMIT);
		} finally {
			db.close();
		}
	});

	test("openDb does NOT synchronously VACUUM a legacy auto_vacuum=NONE DB", () => {
		const path = join(tempDir(), "legacy-fast-open.db");
		makeLegacyDb(path, 200);
		const db = openDb(path);
		try {
			expect(pragmaInt(db, "auto_vacuum")).toBe(0);
			expect(pragmaInt(db, "freelist_count")).toBeGreaterThan(50);
		} finally {
			db.close();
		}
	});

	test("convertToIncrementalAutoVacuum handles size cap, no-space, cooldown marker, failure, and forced conversion", () => {
		const path = join(tempDir(), "legacy-convert.db");
		makeLegacyDb(path, 300);
		const db = openDb(path);
		try {
			const logs: string[] = [];

			// 1. Live bytes exceed threshold -> skipped_large with opt-in hint, no marker left behind.
			const large = convertToIncrementalAutoVacuum(db, path, { maxLiveBytes: 1, onLog: (m) => logs.push(m) });
			expect(large.status).toBe("skipped_large");
			expect(logs.some((m) => m.includes("PIPAYA_DB_VACUUM=1"))).toBe(true);
			expect(existsSync(`${path}.vacuum-attempted`)).toBe(false);

			// 2. Insufficient free disk space -> skipped_no_space.
			const noSpace = convertToIncrementalAutoVacuum(db, path, { hasRoom: () => false, onLog: (m) => logs.push(m) });
			expect(noSpace.status).toBe("skipped_no_space");
			expect(pragmaInt(db, "auto_vacuum")).toBe(0);

			// 3. Simulated previous crash/kill marker within cooldown -> skipped_cooldown (prevents retry loop).
			const t0 = 1_700_000_000_000;
			writeFileSync(`${path}.vacuum-attempted`, String(t0));
			const cooled = convertToIncrementalAutoVacuum(db, path, { now: () => t0 + 1000, onLog: (m) => logs.push(m) });
			expect(cooled.status).toBe("skipped_cooldown");
			expect(pragmaInt(db, "auto_vacuum")).toBe(0);

			// 4. VACUUM failure (e.g. inside an active transaction) is caught and logged, not thrown, leaving cooldown marker.
			db.exec("BEGIN");
			const failed = convertToIncrementalAutoVacuum(db, path, { force: true, now: () => t0 + 2000, onLog: (m) => logs.push(m) });
			db.exec("ROLLBACK");
			expect(failed.status).toBe("failed");
			expect(existsSync(`${path}.vacuum-attempted`)).toBe(true);
			expect(logs.some((m) => m.includes("failed"))).toBe(true);

			// 5. Force (or expired cooldown) converts to INCREMENTAL, reclaims free pages, and removes the attempt marker.
			const converted = convertToIncrementalAutoVacuum(db, path, { force: true, onLog: (m) => logs.push(m) });
			expect(converted.status).toBe("converted");
			expect(pragmaInt(db, "auto_vacuum")).toBe(2);
			expect(pragmaInt(db, "freelist_count")).toBe(0);
			expect(existsSync(`${path}.vacuum-attempted`)).toBe(false);

			// 6. Calling again is an instant no-op.
			expect(convertToIncrementalAutoVacuum(db, path).status).toBe("already_incremental");
		} finally {
			db.close();
		}
	});

	test("maintainDb incrementally reclaims deleted pages, truncates WAL, and is safe on :memory:", () => {
		const mem = openDb(":memory:");
		expect(maintainDb(mem, { maxIncrementalPages: 0 }).reclaimedPages).toBe(0);
		expect(convertToIncrementalAutoVacuum(mem, ":memory:").status).toBe("skipped_memory");
		mem.close();

		const path = join(tempDir(), "maint.db");
		const db = openDb(path);
		try {
			const ins = db.query("INSERT INTO events (session_id, type, data, ts) VALUES (NULL, 'ping', $d, $t)");
			db.transaction(() => {
				for (let i = 0; i < 300; i++) ins.run({ d: JSON.stringify({ pad: "z".repeat(4000) }), t: 1 });
			})();
			db.exec("DELETE FROM events");
			expect(pragmaInt(db, "freelist_count")).toBeGreaterThan(50);

			const skipped = maintainDb(db, { maxIncrementalPages: 0 });
			expect(skipped.reclaimedPages).toBe(0);
			expect(skipped.walTruncated).toBe(true);

			const res = maintainDb(db, { maxIncrementalPages: 4096, chunkPages: 64, budgetMs: 5000 });
			expect(res.reclaimedPages).toBeGreaterThan(50);
			expect(res.walTruncated).toBe(true);
			expect(pragmaInt(db, "freelist_count")).toBe(0);
			if (existsSync(`${path}-wal`)) {
				expect(statSync(`${path}-wal`).size).toBe(0);
			}
		} finally {
			db.close();
		}
	});
});

describe("SessionStore toolResult image replacement", () => {
	test("replaceToolMessageImages preserves non-empty content via placeholder and leaves non-image messages untouched", () => {
		const imageOnly = toolResultWithImage("t0");
		const replaced = replaceToolMessageImages(imageOnly) as unknown as { content: { type: string; text?: string }[] };
		expect(replaced.content).toEqual([{ type: "text", text: STORAGE_IMAGE_PLACEHOLDER }]);

		const user = userWithImage("keep");
		expect(replaceToolMessageImages(user)).toBe(user);

		const textOnly = { role: "toolResult", content: [{ type: "text", text: "ok" }] };
		expect(replaceToolMessageImages(textOnly)).toBe(textOnly);
	});

	test("stripToolImages handles upToSeq=0, inserts placeholder, preserves user & newer images, and skips damaged rows", () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		makeSession(db, store, "s1");

		store.appendMessage("s1", 0, toolResultWithImage("t0")); // image-only -> placeholder prevents empty content[]
		store.appendMessage("s1", 1, userWithImage("keep my user photo"));
		store.appendMessage("s1", 2, toolResultWithImage("t2", "at seq 2"));
		db.query("INSERT INTO messages (session_id, seq, role, data, created_at) VALUES ('s1', 3, 'toolResult', '{broken \"type\":\"image\"', 1)").run();
		store.appendMessage("s1", 4, toolResultWithImage("t4", "after cutoff"));

		expect(store.stripToolImages("s1", 0)).toBe(1);
		const row0 = db.query("SELECT data FROM messages WHERE session_id = 's1' AND seq = 0").get() as { data: string };
		const m0 = JSON.parse(row0.data) as { content: { type: string; text?: string }[] };
		expect(m0.content).toEqual([{ type: "text", text: STORAGE_IMAGE_PLACEHOLDER }]);

		// Compaction up to seq 3 replaces seq 2 image with placeholder while preserving seq 1 user image and seq 4.
		store.addCompaction("s1", { uptoSeq: 3, summary: "summary", tokensBefore: 100, usage: null });
		const rows = db.query("SELECT seq, data FROM messages WHERE session_id = 's1' AND seq != 3 ORDER BY seq").all() as { seq: number; data: string }[];
		const bySeq = new Map(rows.map((r) => [r.seq, JSON.parse(r.data) as { content: { type: string; text?: string }[] }]));
		expect(bySeq.get(1)!.content.some((c) => c.type === "image")).toBe(true);
		expect(bySeq.get(2)!.content.some((c) => c.type === "image")).toBe(false);
		expect(bySeq.get(2)!.content.some((c) => c.type === "text" && c.text === "at seq 2")).toBe(true);
		expect(bySeq.get(2)!.content.some((c) => c.type === "text" && c.text === STORAGE_IMAGE_PLACEHOLDER)).toBe(true);
		expect(bySeq.get(4)!.content.some((c) => c.type === "image")).toBe(true);

		expect(store.stripToolImages("s1", -1)).toBe(0);
		db.close();
	});

	test("addCompaction rolls back image stripping atomically if the transaction fails", () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		makeSession(db, store, "s1");
		store.appendMessage("s1", 0, toolResultWithImage("t0", "keep on rollback"));

		// Trigger an abort on the messages UPDATE inside addCompaction so the whole transaction rolls back.
		db.exec("CREATE TRIGGER fail_msg_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END;");
		expect(() => store.addCompaction("s1", { uptoSeq: 0, summary: "summary", tokensBefore: 10, usage: null })).toThrow("boom");
		expect(store.latestCompaction("s1")).toBeUndefined();
		const m0 = store.messages("s1")[0]!.message as { content: { type: string }[] };
		expect(m0.content.some((c) => c.type === "image")).toBe(true);
		db.close();
	});

	test("pruneClosedToolImages only strips old closed sessions and is not starved by false positives", () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		const now = Date.now();
		const oldTime = now - 10 * 24 * 3600_000;
		const recentTime = now - 2 * 24 * 3600_000;
		const cutoff = now - 7 * 24 * 3600_000;

		makeSession(db, store, "open-old", { closed: false, updatedAt: oldTime });
		makeSession(db, store, "closed-recent", { closed: true, updatedAt: recentTime });
		makeSession(db, store, "closed-old-a", { closed: true, updatedAt: oldTime });
		makeSession(db, store, "closed-old-b", { closed: true, updatedAt: oldTime });

		store.appendMessage("open-old", 0, toolResultWithImage("o0"));
		store.appendMessage("closed-recent", 0, toolResultWithImage("r0"));
		store.appendMessage("closed-old-a", 0, userWithImage("keep user image"));
		for (let i = 1; i <= 120; i++) {
			store.appendMessage("closed-old-a", i, {
				role: "toolResult",
				toolCallId: `fp-${i}`,
				toolName: "grep",
				isError: false,
				timestamp: oldTime,
				details: { type: "image" },
				content: [{ type: "text", text: "no image block in content" }],
			} as unknown as AgentMessage);
		}
		store.appendMessage("closed-old-a", 121, toolResultWithImage("a121", "real image a"));
		store.appendMessage("closed-old-b", 0, toolResultWithImage("b0"));
		setUpdatedAt(db, "open-old", oldTime);
		setUpdatedAt(db, "closed-recent", recentTime);
		setUpdatedAt(db, "closed-old-a", oldTime);
		setUpdatedAt(db, "closed-old-b", oldTime);

		expect(store.pruneClosedToolImages(cutoff, 0)).toBe(0);
		expect(store.pruneClosedToolImages(cutoff, { limit: 1, budgetMs: 5000 })).toBe(1);
		const aMsgs = new Map(store.messages("closed-old-a").map((m) => [m.seq, m.message as { content: { type: string; text?: string }[] }]));
		expect(aMsgs.get(0)!.content.some((c) => c.type === "image")).toBe(true);
		expect(aMsgs.get(121)!.content.some((c) => c.type === "image")).toBe(false);
		expect(aMsgs.get(121)!.content.some((c) => c.type === "text" && c.text === STORAGE_IMAGE_PLACEHOLDER)).toBe(true);
		expect((store.messages("closed-old-b")[0]!.message as { content: { type: string }[] }).content.some((c) => c.type === "image")).toBe(true);

		expect(store.pruneClosedToolImages(cutoff, { limit: 10, budgetMs: 5000 })).toBe(1);
		expect((store.messages("closed-old-b")[0]!.message as { content: { type: string; text?: string }[] }).content).toEqual([
			{ type: "text", text: STORAGE_IMAGE_PLACEHOLDER },
		]);
		expect((store.messages("open-old")[0]!.message as { content: { type: string }[] }).content.some((c) => c.type === "image")).toBe(true);
		expect((store.messages("closed-recent")[0]!.message as { content: { type: string }[] }).content.some((c) => c.type === "image")).toBe(true);
		db.close();
	});
});

describe("Retention onPurged hook, SessionMedia orphan sweep & cache bounds", () => {
	test("Retention invokes onPurged only when sessions are deleted and catches hook errors", () => {
		const db = openDb(":memory:");
		const store = new SessionStore(db);
		const calls: number[] = [];
		const removed: string[] = [];
		const retention = new Retention(
			db,
			store,
			() => false,
			(id) => {
				removed.push(id);
				store.delete(id);
			},
			() => {},
			(n) => {
				calls.push(n);
				throw new Error("hook failed");
			},
		);
		retention.set({ enabled: true, days: 7, onlyClosed: true });

		// Nothing old -> onPurged must not be called.
		expect(retention.run()).toBe(0);
		expect(calls).toEqual([]);

		// One old closed session -> onPurged called with 1, and throwing hook does not break run().
		const oldTime = Date.now() - 10 * 24 * 3600_000;
		makeSession(db, store, "expired-1", { closed: true, updatedAt: oldTime });
		expect(retention.run()).toBe(1);
		expect(removed).toEqual(["expired-1"]);
		expect(calls).toEqual([1]);
		db.close();
	});

	test("SessionMedia.sweepOrphans removes dead folders and delete() caps gen entries to dead IDs only", async () => {
		const root = join(tempDir(), "session-media");
		const alive = new Set(["alive-1"]);
		const media = new SessionMedia(root, (id) => alive.has(id), { maxGenEntries: 2 });

		expect(await media.sweepOrphans()).toBe(0);

		mkdirSync(join(root, "alive-1"), { recursive: true });
		mkdirSync(join(root, "orphan-1"), { recursive: true });
		mkdirSync(join(root, "orphan-2"), { recursive: true });
		mkdirSync(join(root, ".hidden"), { recursive: true });
		writeFileSync(join(root, "stray-file.txt"), "keep");
		writeFileSync(join(root, "orphan-1", "img.png"), "data");

		expect(await media.sweepOrphans()).toBe(2);
		expect(existsSync(join(root, "alive-1"))).toBe(true);
		expect(existsSync(join(root, "orphan-1"))).toBe(false);
		expect(existsSync(join(root, "orphan-2"))).toBe(false);
		expect(existsSync(join(root, ".hidden"))).toBe(true);
		expect(existsSync(join(root, "stray-file.txt"))).toBe(true);

		// gen cap: keep alive-1 and current deleting id, evict dead older IDs.
		await media.delete("alive-1");
		await media.delete("dead-1");
		await media.delete("dead-2");
		await media.delete("dead-3");
		const gen = (media as unknown as { gen: Map<string, number> }).gen;
		expect(gen.size).toBe(2);
		expect(gen.has("alive-1")).toBe(true);
		expect(gen.has("dead-3")).toBe(true);
		expect(gen.has("dead-1")).toBe(false);
	});

	test("subagents scopeCache and OpenRouterCatalog tierCache evict entries past their bounds", async () => {
		// subagents scopeCache bounded at 64 entries
		const root = tempDir("pipaya-subagents-");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		for (let i = 0; i < 70; i++) {
			const dir = join(root, `p-${i}`);
			mkdirSync(join(dir, ".agents", "subagents"), { recursive: true });
			writeFileSync(join(dir, ".agents", "subagents", "a.md"), "---\nname: a\ndescription: d\n---\nbody");
			loadSubagents(dir, home);
		}
		// Reloading recent project still works cleanly after evictions.
		expect(loadSubagents(join(root, "p-69"), home).has("a")).toBe(true);

		// OpenRouterCatalog tierCache expires old entries first and enforces MAX_TIER_CACHE (256).
		let clock = 10_000;
		const modelList = Array.from({ length: 260 }, (_, i) => ({
			id: `org/model-${i}`,
			name: `Model ${i}`,
			context_length: 8192,
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		}));
		const mockFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/endpoints")) {
				return new Response(JSON.stringify({ data: { endpoints: [{ service_tier: "priority" }] } }), { status: 200 });
			}
			return new Response(JSON.stringify({ data: modelList }), { status: 200 });
		}) as unknown as typeof fetch;
		const catalog = new OpenRouterCatalog({
			dataDir: tempDir(),
			now: () => clock,
			cacheMs: 1000,
			fetch: mockFetch,
		});
		for (let i = 0; i < 260; i++) {
			if (i === 100) clock += 2000; // expire first 100 entries before overflowing 256
			await catalog.serviceTiers(`org/model-${i}`);
		}
		const tierCache = (catalog as unknown as { tierCache: Map<string, { at: number }> }).tierCache;
		expect(tierCache.size).toBeLessThanOrEqual(256);
		expect(tierCache.size).toBeGreaterThan(100);
		expect(tierCache.has("org/model-0")).toBe(false);
		expect(tierCache.has("org/model-259")).toBe(true);
	});

	test("buildApp runs startup storage maintenance and closes cleanly", async () => {
		const dataDir = tempDir("pipaya-app-");
		const dbPath = join(dataDir, "pipaya.db");
		// Seed an expired event before buildApp starts.
		const seed = openDb(dbPath);
		seed.query("INSERT INTO events (session_id, type, data, ts) VALUES (NULL, 'ping', '{}', 1)").run();
		seed.close();

		const cfg: Config = {
			host: "127.0.0.1",
			port: 0,
			token: "test-token",
			dataDir,
			dbPath,
			workspaceRoot: dataDir,
			logLevel: "silent",
			pushEnabled: false,
		};
		const app = await buildApp(cfg, { pushTransports: {}, extensionDirs: [] });
		try {
			const history = app.bus.history({ after: 0, limit: 20 });
			expect(history.some((e) => e.type === "ping")).toBe(false);
		} finally {
			await app.close();
		}
	});
});
