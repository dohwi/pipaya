import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { DAY_MS, Retention } from "../src/retention.ts";
import { SessionStore } from "../src/store.ts";

const NOW = 1_000 * DAY_MS;

function setup(busy: string[] = []) {
	const db = openDb(":memory:");
	const store = new SessionStore(db);
	const put = db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ($id, 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, $at, $closed, '')");
	const add = (id: string, daysAgo: number, closed = false) => put.run({ id, at: NOW - daysAgo * DAY_MS, closed: closed ? 1 : 0 });
	const removed: string[] = [];
	const r = new Retention(db, store, (id) => busy.includes(id), (id) => { removed.push(id); store.delete(id); });
	return { db, store, r, add, removed };
}

describe("Retention", () => {
	test("off by default: nothing is due and a run deletes nothing", () => {
		const { r, add, removed } = setup();
		add("old", 400, true);
		expect(r.get()).toEqual({ enabled: false, days: 30, onlyClosed: true });
		expect(r.run(NOW)).toBe(0);
		expect(r.info(NOW).due).toBe(0);
		expect(removed).toEqual([]);
	});

	test("deletes sessions older than the policy, oldest first, and keeps busy ones", () => {
		const { r, add, removed, store } = setup(["busy"]);
		add("fresh", 5); add("old", 40); add("older", 90); add("busy", 100); add("closed-old", 50, true);
		r.set({ enabled: true, days: 30, onlyClosed: false });
		expect(r.candidates(NOW)).toEqual(["older", "closed-old", "old"]);
		expect(r.run(NOW)).toBe(3);
		expect(removed).toEqual(["older", "closed-old", "old"]);
		expect(store.get("fresh")).toBeDefined();
		expect(store.get("busy")).toBeDefined();
		expect(r.info(NOW)).toMatchObject({ lastRun: NOW, lastDeleted: 3, due: 0 });
	});

	test("onlyClosed spares active sessions however old", () => {
		const { r, add, removed } = setup();
		add("active-old", 90); add("closed-old", 90, true);
		r.set({ enabled: true, days: 30, onlyClosed: true });
		expect(r.run(NOW)).toBe(1);
		expect(removed).toEqual(["closed-old"]);
	});

	test("pages through more than one page of sessions", () => {
		const { r, add } = setup();
		for (let i = 0; i < 1203; i++) add(`s${i}`, 31 + i / 10000);
		r.set({ enabled: true, days: 30, onlyClosed: false });
		expect(r.candidates(NOW).length).toBe(1203);
	});
});

describe("retention routes", () => {
	let app: App;
	let dir: string;
	const api = async (method: any, url: string, payload?: unknown) => {
		const res = await app.server.inject({
			method, url,
			headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
			...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
		});
		return { status: res.statusCode, json: res.body ? res.json() : undefined };
	};
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-retention-"));
		const ws = join(dir, "ws");
		mkdirSync(ws);
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true });
	});
	afterAll(async () => {
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("GET/PUT /retention and POST /retention/run", async () => {
		const got = await api("GET", "/retention");
		expect(got.status).toBe(200);
		expect(got.json).toMatchObject({ settings: { enabled: false }, lastRun: null, lastDeleted: 0, due: 0 });
		expect((await api("PUT", "/retention", { enabled: true, days: 0, onlyClosed: true })).status).toBe(400);
		const put = await api("PUT", "/retention", { enabled: true, days: 7, onlyClosed: false });
		expect(put.status).toBe(200);
		expect(put.json.settings).toEqual({ enabled: true, days: 7, onlyClosed: false });
		const run = await api("POST", "/retention/run");
		expect(run.json).toEqual({ deleted: 0 });
		expect((await api("GET", "/retention")).json.lastRun).toBeGreaterThan(0);
	});
});
