import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { CompactionSettings, estimateTokens, pickCut, thresholdFor } from "../src/compaction.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
const LIGHT = { id: "echo-light", name: "Echo light", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false };
const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-compaction-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	expect((await api("PUT", "/configuration/providers/echo", { ...echoProviderBody(upstream.baseUrl), models: [ECHO_MODEL, LIGHT] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function untilIdle(id: string) {
	for (let i = 0; i < 300; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
}
const newSession = async () => (await api("POST", "/sessions", { cwd: ws, approval: "auto" })).json.id as string;
const say = async (id: string, text: string) => { await api("POST", `/sessions/${id}/messages`, { text }); await untilIdle(id); };
const modelsUsed = () => upstream.requests.map((r) => r.body?.model);

describe("compaction model setting", () => {
	test("defaults to the session's own model, and auto compaction on", async () => {
		const r = (await api("GET", "/compaction")).json;
		expect(r.settings).toEqual({ auto: true, model: null });
		expect(r.defaults).toEqual({ auto: true, model: null });
	});

	test("saves a model, clears it with null, rejects an unknown one and bad bodies", async () => {
		expect((await api("PUT", "/compaction", { auto: false, model: { provider: "echo", model: LIGHT.id } })).json.settings).toEqual({ auto: false, model: { provider: "echo", model: LIGHT.id } });
		expect((await api("GET", "/compaction")).json.settings.model).toEqual({ provider: "echo", model: LIGHT.id });
		expect((await api("PUT", "/compaction", { auto: true, model: { provider: "echo", model: "nope" } })).status).toBe(400);
		expect((await api("PUT", "/compaction", { auto: true })).status).toBe(400);
		expect((await api("GET", "/compaction")).json.settings.model).toEqual({ provider: "echo", model: LIGHT.id });
		expect((await api("PUT", "/compaction", { auto: true, model: null })).json.settings).toEqual({ auto: true, model: null });
	});
});

describe("POST /sessions/:id/compact", () => {
	test("refuses when there is nothing to compact", async () => {
		const id = await newSession();
		await say(id, "only one message");
		expect((await api("POST", `/sessions/${id}/compact`, {})).status).toBe(409);
	});

	test("with no compaction model it uses the session's model, and later requests carry the summary instead of old messages", async () => {
		await api("PUT", "/compaction", { auto: false, model: null });
		const id = await newSession();
		for (const t of ["first-question", "second-question", "third-question"]) await say(id, t);

		upstream.requests.length = 0;
		const r = await api("POST", `/sessions/${id}/compact`, { customInstructions: "keep file names" });
		expect(r.status).toBe(200);
		expect(r.json.model).toEqual({ provider: "echo", model: ECHO_MODEL.id, custom: false });
		expect(modelsUsed()).toEqual([ECHO_MODEL.id]);
		expect(upstream.requests[0]!.body.messages.at(-1).content).toContain("keep file names");

		upstream.requests.length = 0;
		await say(id, "after-compaction");
		const sent = JSON.stringify(upstream.requests.at(-1)!.body.messages);
		expect(sent).toContain("after-compaction");
		expect(sent).toContain("compacted");
		// The echo upstream repeats the summary request inside the "summary", so look for the original messages instead.
		const sentMessages = upstream.requests.at(-1)!.body.messages as any[];
		expect(sentMessages.some((m) => m.role === "assistant" && m.content === "Echo: first-question")).toBe(false);
		expect(sentMessages.filter((m) => m.role === "user" && JSON.stringify(m.content) === '[{"type":"text","text":"first-question"}]')).toHaveLength(0);

		// The stored transcript is untouched.
		const stored = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
		expect(stored).toContain("first-question");
	});

	test("a configured compaction model writes the summary instead", async () => {
		await api("PUT", "/compaction", { auto: false, model: { provider: "echo", model: LIGHT.id } });
		const id = await newSession();
		for (const t of ["one", "two", "three"]) await say(id, t);
		upstream.requests.length = 0;
		const r = await api("POST", `/sessions/${id}/compact`, {});
		expect(r.status).toBe(200);
		expect(r.json.model).toEqual({ provider: "echo", model: LIGHT.id, custom: true });
		expect(modelsUsed()).toEqual([LIGHT.id]);
		await api("PUT", "/compaction", { auto: false, model: null });
	});

	test("a configured model that no longer exists falls back to the session's model", () => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		db.query("INSERT INTO settings (key, data) VALUES ('compaction', $d)").run({ d: JSON.stringify({ auto: false, model: { provider: "echo", model: "gone" } }) });
		const registry = { models: { getModel: (p: string, m: string) => (m === "gone" ? undefined : { provider: p, id: m }) } } as any;
		const settings = new CompactionSettings(db, registry);
		expect(settings.resolveModel({ provider: "echo", model: "session-model" })).toEqual({ provider: "echo", model: "session-model", custom: false });
		settings.set({ auto: true, model: { provider: "echo", model: "light" } });
		expect(settings.resolveModel({ provider: "echo", model: "session-model" })).toEqual({ provider: "echo", model: "light", custom: true });
		db.close();
	});

	test("the summary's cost is counted in the session usage, and events are published", async () => {
		await api("PUT", "/compaction", { auto: false, model: null });
		const id = await newSession();
		for (const t of ["a", "b", "c"]) await say(id, t);
		const before = (await api("GET", `/sessions/${id}`)).json.usage.totalTokens;
		await api("POST", `/sessions/${id}/compact`, {});
		const detail = (await api("GET", `/sessions/${id}`)).json;
		expect(detail.usage.totalTokens).toBeGreaterThan(before);
		expect(detail.status.compacting).toBe(false);
		expect(detail.compaction).toEqual({ supported: true, autoEnabled: false });
		expect(detail.context.contextWindow).toBe(ECHO_MODEL.contextWindow);
		const types = app.bus.history({ sessionId: id, after: 0, limit: 500 }).map((e) => e.type);
		expect(types).toContain("compaction_started");
		expect(types).toContain("compaction_finished");
		expect(types).toContain("context_updated");
	});

	test("a summary failure leaves the context alone and reports compaction_failed", async () => {
		await api("PUT", "/compaction", { auto: false, model: null });
		const id = await newSession();
		for (const t of ["a", "b", "c"]) await say(id, t);
		const real = app.sessions as any;
		const original = real.registry.models.completeSimple;
		real.registry.models.completeSimple = async () => ({ stopReason: "error", errorMessage: "boom", content: [], usage: {} });
		try {
			const r = await api("POST", `/sessions/${id}/compact`, {});
			expect(r.status).toBe(502);
		} finally {
			real.registry.models.completeSimple = original;
		}
		const failed = app.bus.history({ sessionId: id, after: 0, limit: 500 }).filter((e) => e.type === "compaction_failed");
		expect(failed).toHaveLength(1);
		expect((failed[0]!.data as any).aborted).toBe(false);
		expect((await api("GET", `/sessions/${id}`)).json.status.compacting).toBe(false);
		expect((await api("POST", `/sessions/${id}/compact`, {})).status).toBe(200);
	});

	test("unknown sessions are 404", async () => {
		expect((await api("POST", "/sessions/nope/compact", {})).status).toBe(404);
	});
});

describe("cut selection", () => {
	const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 0 }) as any;
	const asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] }) as any;
	const result = (t: string) => ({ role: "toolResult", toolName: "read", content: [{ type: "text", text: t }] }) as any;

	test("needs an earlier user message to cut at", () => {
		expect(pickCut([user("a"), asst("b")])).toBeNull();
	});

	test("cuts on a user message, never between a tool call and its result", () => {
		const big = "x".repeat(40_000);
		const msgs = [user("1"), asst(big), result(big), user("2"), asst(big), result(big), user("3"), asst("short")];
		const cut = pickCut(msgs, 5000)!;
		expect(msgs[cut]!.role).toBe("user");
		expect(cut).toBeGreaterThan(0);
	});

	test("keeps everything it can within the recent budget", () => {
		const msgs = [user("1"), asst("a"), user("2"), asst("b"), user("3"), asst("c")];
		expect(pickCut(msgs, 1_000_000)).toBe(2);
	});

	test("token estimate and automatic threshold", () => {
		expect(estimateTokens(user("abcd".repeat(100)))).toBe(100);
		expect(thresholdFor(1_000_000)).toBe(1_000_000 - 16_384);
		expect(thresholdFor(8192)).toBe(4096);
	});
});
