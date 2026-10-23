import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let base: string;
let dir: string;
let upstream: EchoUpstream;
let db: Database;
const TOKEN = "test-token-retention";
const auth = { authorization: `Bearer ${TOKEN}` };
const DAY = 24 * 3600_000;

const api = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(base + path, {
		method,
		headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
/** A session whose last use was `days` days ago. */
const aged = async (days: number, extra: Record<string, unknown> = {}) => {
	const id = (await api("POST", "/sessions", { approval: "auto", ...extra })).json.id as string;
	db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() - days * DAY });
	return id;
};
const exists = async (id: string) => (await api("GET", `/sessions/${id}`)).status === 200;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-retention-"));
	upstream = startEchoUpstream();
	const cfg: Config = {
		host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "test.db"), token: TOKEN, workspaceRoot: join(dir, "ws"),
		defaultApproval: "ask", approvalTimeoutMs: 0, logLevel: "silent",
	};
	app = await buildApp(cfg, { strictResponses: true, extensionDirs: [join(import.meta.dir, "support/ext")] });
	await app.server.listen({ host: "0.0.0.0", port: 0 });
	base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
	await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
	await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	db = new Database(join(dir, "test.db"), { strict: true });
});
afterAll(async () => {
	db.close();
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("deleting sessions", () => {
	test("several sessions are deleted at once, and unknown ids are reported as skipped", async () => {
		const a = await aged(0), b = await aged(0), keep = await aged(0);
		const r = await api("POST", "/sessions/delete", { ids: [a, b, "nope"] });
		expect(r.status).toBe(200);
		expect(r.json.deleted.sort()).toEqual([a, b].sort());
		expect(r.json.skipped).toEqual(["nope"]);
		expect(await exists(a)).toBe(false);
		expect(await exists(keep)).toBe(true);
	});

	test("a session waiting for an answer is not deleted", async () => {
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: `!ask_user ${JSON.stringify({ question: "Which?" })}` });
		for (let i = 0; i < 100 && !(await api("GET", `/questions?sessionId=${id}`)).json.questions.length; i++) await Bun.sleep(20);
		const r = await api("POST", "/sessions/delete", { ids: [id] });
		expect(r.json).toEqual({ deleted: [], skipped: [id] });
		expect(await exists(id)).toBe(true);
		await api("POST", `/sessions/${id}/abort`);
	});

	test("an empty list is refused", async () => {
		expect((await api("POST", "/sessions/delete", { ids: [] })).status).toBe(400);
	});
});

describe("automatic clean-up", () => {
	test("the policy starts off, is saved, and is validated", async () => {
		expect((await api("GET", "/sessions/retention")).json.policy).toEqual({ enabled: false, days: 30, onlyClosed: false });
		expect((await api("PUT", "/sessions/retention", { enabled: true, days: 0, onlyClosed: false })).status).toBe(400);
		const r = await api("PUT", "/sessions/retention", { enabled: true, days: 30, onlyClosed: false });
		expect(r.status).toBe(200);
		expect(r.json.policy).toEqual({ enabled: true, days: 30, onlyClosed: false });
		expect((await api("GET", "/sessions/retention")).json.policy.days).toBe(30);
	});

	test("it deletes sessions older than the limit and keeps the rest", async () => {
		await api("PUT", "/sessions/retention", { enabled: true, days: 30, onlyClosed: false });
		const old = await aged(45), edge = await aged(29), fresh = await aged(0);
		expect((await api("GET", "/sessions/retention")).json.due).toBeGreaterThanOrEqual(1);
		const n = app.retention.run();
		expect(n).toBeGreaterThanOrEqual(1);
		expect(await exists(old)).toBe(false);
		expect(await exists(edge)).toBe(true);
		expect(await exists(fresh)).toBe(true);
		const info = (await api("GET", "/sessions/retention")).json;
		expect(info.lastRun).toBeGreaterThan(0);
		expect(info.lastDeleted).toBe(n);
	});

	test("with 'only closed', an old active session is kept", async () => {
		await api("PUT", "/sessions/retention", { enabled: true, days: 30, onlyClosed: true });
		const oldActive = await aged(90), oldClosed = await aged(90);
		await api("PATCH", `/sessions/${oldClosed}`, { closed: true });
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id: oldClosed, t: Date.now() - 90 * DAY });
		app.retention.run();
		expect(await exists(oldActive)).toBe(true);
		expect(await exists(oldClosed)).toBe(false);
	});

	test("nothing is deleted while the policy is off", async () => {
		await api("PUT", "/sessions/retention", { enabled: false, days: 1, onlyClosed: false });
		const old = await aged(400);
		expect(app.retention.run()).toBe(0);
		expect(await exists(old)).toBe(true);
		expect((await api("GET", "/sessions/retention")).json.due).toBe(0);
	});

	test("a session that is waiting for the user is never deleted, however old", async () => {
		await api("PUT", "/sessions/retention", { enabled: true, days: 1, onlyClosed: false });
		const id = (await api("POST", "/sessions", { approval: "auto" })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: `!ask_user ${JSON.stringify({ question: "Still here?" })}` });
		for (let i = 0; i < 100 && !(await api("GET", `/questions?sessionId=${id}`)).json.questions.length; i++) await Bun.sleep(20);
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() - 400 * DAY });
		app.retention.run();
		expect(await exists(id)).toBe(true);
		await api("POST", `/sessions/${id}/abort`);
	});
});
