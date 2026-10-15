import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";

let app: App;
let dir: string;
let cfg: Config;
let upstream: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const key = "private-test-secret";
let requests: { path: string; key: string | null; body: any }[] = [];
const body = () => ({ name: "Local test", baseUrl, api: "openai-completions", authRequired: false,
	models: [{ id: "test-model", name: "Test", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false }] });
const api = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({ method, url, headers: auth ? { authorization: "Bearer test-token" } : {}, ...(payload === undefined ? {} : { payload: payload === null ? "null" : payload, ...(payload === null ? { headers: { authorization: "Bearer test-token", "content-type": "application/json" } } : {}) }) });
	return { status: r.statusCode, body: r.headers["content-type"]?.includes("application/json") ? r.json() : r.body, headers: r.headers };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-settings-"));
	upstream = Bun.serve({ hostname: "0.0.0.0", port: 0, async fetch(req) {
		requests.push({ path: new URL(req.url).pathname, key: req.headers.get("authorization"), body: await req.json() });
		if (new URL(req.url).pathname.endsWith("/messages")) {
			const message = { id: "msg_mock", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } };
			const events = [
				{ type: "message_start", message },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			];
			return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		}
		if (new URL(req.url).pathname.endsWith("/responses")) {
			const item = { id: "msg_mock", type: "message", role: "assistant", status: "in_progress", content: [] };
			const response = { id: "resp_mock", object: "response", status: "completed", model: "test-model", output: [{ ...item, status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } };
			const events = [
				{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
				{ type: "response.output_item.done", output_index: 0, item: response.output[0] },
				{ type: "response.completed", response },
			];
			return new Response(events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		}
		const chunk = { id: "mock", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] };
		const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	} });
	baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
	cfg = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "workspace"), defaultApproval: "ask", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => { await app.close(); upstream.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("settings", () => {
	test("all configuration APIs require bearer authentication and never leak the token", async () => {
		for (const [method, path, payload] of [
			["GET", "/configuration", undefined],
			["PUT", "/configuration/providers/private", body()],
			["DELETE", "/configuration/providers/private", undefined],
			["PUT", "/configuration/defaults", { provider: "private", model: "test-model" }],
			["POST", "/configuration/test", { provider: "private", model: "test-model" }],
		] as const) {
			const r = await api(method, path, payload, false);
			expect(r.status).toBe(401);
			expect(JSON.stringify(r.body)).not.toContain("test-token");
		}
		expect((await api("GET", "/configuration?token=test-token", undefined, false)).status).toBe(401);
		expect((await api("GET", "/configuration")).status).toBe(200);
	});

	test("validates endpoint, provider IDs, duplicate models and limits", async () => {
		for (const baseUrl of ["file:///etc/passwd", "http://user:secret@host/v1", "https://host/v1?key=secret", "not-url"]) {
			expect((await api("PUT", "/configuration/providers/invalid", { ...body(), baseUrl })).status).toBe(400);
		}
		// Standard provider names are ordinary user IDs now; nothing is reserved.
		const openai = await api("PUT", "/configuration/providers/openai", body());
		expect(openai.status).toBe(200);
		expect(openai.body.id).toBe("openai");
		expect((await api("GET", "/models?provider=openai")).body.models.map((m: any) => m.id)).toEqual(["test-model"]);
		expect((await api("DELETE", "/configuration/providers/openai")).status).toBe(200);
		expect((await api("GET", "/models?provider=openai")).body.models.map((m: any) => m.id)).not.toContain("test-model"); // the built-in provider is back
		expect((await api("PUT", "/configuration/providers/Bad id", body())).status).toBe(400);
		expect((await api("PUT", "/configuration/providers/invalid", { ...body(), models: [body().models[0], body().models[0]] })).status).toBe(400);
		expect((await api("PUT", "/configuration/providers/invalid", { ...body(), models: [{ ...body().models[0], maxTokens: 99999 }] })).status).toBe(400);
		expect((await api("PUT", "/configuration/providers/invalid", { ...body(), key })).status).toBe(400);
	});

	test("keyless custom endpoint registers and runs actual inference", async () => {
		const saved = await api("PUT", "/configuration/providers/local-test", body());
		expect(saved.status).toBe(200);
		expect(saved.body.configured).toBe(true);
		expect(saved.body.hasStoredKey).toBe(false);
		const r = await api("POST", "/configuration/test", { provider: "local-test", model: "test-model" });
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.text).toBe("OK");
		expect(requests.at(-1)!.path).toBe("/v1/chat/completions");
		expect(requests.at(-1)!.body.model).toBe("test-model");
	});

	test("Responses and Anthropic formats dispatch to their upstream APIs", async () => {
		for (const [id, format, suffix] of [["responses-test", "openai-responses", "/v1/responses"], ["anthropic-test", "anthropic-messages", "/v1/messages"]]) {
			expect((await api("PUT", `/configuration/providers/${id}`, { ...body(), api: format, baseUrl: format === "anthropic-messages" ? baseUrl.replace("/v1", "") : baseUrl })).status).toBe(200);
			const r = await api("POST", "/configuration/test", { provider: id, model: "test-model" });
			expect(r.body.ok).toBe(true);
			expect(r.body.text).toBe("OK");
			expect(requests.at(-1)!.path).toBe(suffix!);
			await api("DELETE", `/configuration/providers/${id}`);
		}
	});

	test("keys are used but never returned in configuration or events", async () => {
		await api("PUT", "/configuration/providers/local-test", { ...body(), authRequired: true });
		expect((await api("POST", "/configuration/test", { provider: "local-test", model: "test-model" })).body.ok).toBe(false);
		expect((await api("POST", "/sessions", { provider: "local-test", model: "test-model" })).status).toBe(400);
		expect((await api("PUT", "/providers/local-test/credential", { key })).status).toBe(200);
		const r = await api("POST", "/configuration/test", { provider: "local-test", model: "test-model" });
		expect(r.body.ok).toBe(true);
		expect(requests.at(-1)!.key).toBe(`Bearer ${key}`);
		const config = await api("GET", "/configuration");
		expect(config.body.providers.find((p: any) => p.id === "local-test").hasStoredKey).toBe(true);
		for (const path of ["/configuration", "/providers", "/events/history"]) {
			expect(JSON.stringify((await api("GET", path)).body)).not.toContain(key);
		}
	});

	test("default settings persist across restart and apply only to new sessions", async () => {
		expect((await api("PUT", "/configuration/providers/second-test", { ...body(), name: "Second test" })).status).toBe(200);
		const before = (await api("POST", "/sessions", { provider: "second-test", model: "test-model" })).body;
		expect(before.provider).toBe("second-test");
		expect((await api("PUT", "/configuration/defaults", { provider: "local-test", model: "test-model" })).status).toBe(200);
		await app.close();
		app = await buildApp(cfg, { strictResponses: true });
		const c = (await api("GET", "/configuration")).body;
		expect(c.defaults.provider).toBe("local-test");
		expect(c.providers.map((p: any) => p.id)).toEqual(["local-test", "second-test"]);
		expect(c.providers.find((p: any) => p.id === "local-test").hasStoredKey).toBe(true);
		expect((await api("GET", `/sessions/${before.id}`)).body.provider).toBe("second-test");
		const after = (await api("POST", "/sessions", {})).body;
		expect(after.provider).toBe("local-test");
		expect((await api("POST", "/configuration/test", c.defaults)).body.ok).toBe(true);
		expect((await api("DELETE", "/configuration/providers/local-test")).status).toBe(409);
		expect((await api("PUT", "/configuration/providers/local-test", { ...body(), models: [{ ...body().models[0], id: "different" }] })).status).toBe(409);
		expect((await api("PUT", "/configuration/defaults", { provider: "not-real", model: "nope" })).status).toBe(400);
		expect((await api("PUT", "/configuration/defaults", null)).status).toBe(200);
		expect((await api("GET", "/configuration")).body.defaults).toBeNull();
		expect((await api("DELETE", "/configuration/providers/local-test")).status).toBe(409); // existing session
		expect((await api("DELETE", "/configuration/providers/second-test")).status).toBe(409); // existing session
		await api("DELETE", `/sessions/${after.id}`);
		await api("DELETE", `/sessions/${before.id}`);
		expect((await api("DELETE", "/configuration/providers/local-test")).status).toBe(200);
		expect((await api("DELETE", "/configuration/providers/second-test")).status).toBe(200);
		expect((await api("GET", "/models?provider=local-test")).body.models).toHaveLength(0);
		expect((await api("GET", "/models?provider=second-test")).body.models).toHaveLength(0);
		expect((await api("GET", "/configuration")).body.providers).toHaveLength(0);
	});

	test("saved provider updates refresh idle sessions", async () => {
		await api("PUT", "/configuration/providers/hot", body());
		const s = (await api("POST", "/sessions", { provider: "hot", model: "test-model" })).body;
		await app.sessions.send(s.id, { text: "one" });
		await app.sessions.idle();
		await api("PUT", "/configuration/providers/hot", { ...body(), baseUrl: baseUrl.replace("/v1", "/updated/v1") });
		await app.sessions.send(s.id, { text: "two" });
		await app.sessions.idle();
		expect(requests.at(-1)!.path).toBe("/updated/v1/chat/completions");
		await api("DELETE", `/sessions/${s.id}`);
		await api("DELETE", "/configuration/providers/hot");
	});

	test("connection failures are sanitized", async () => {
		await api("PUT", "/configuration/providers/fail", { ...body(), baseUrl: "http://127.0.0.1:1/v1" });
		const r = await api("POST", "/configuration/test", { provider: "fail", model: "test-model" });
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(false);
		expect(r.body.error).toContain("failed");
		await api("DELETE", "/configuration/providers/fail");
	});

	test("config honors data directory overrides", () => {
		const conf = loadConfig({ PIPAYA_DATA_DIR: dir, PIPAYA_TOKEN: "explicit-token-0123456789-abcdef" });
		expect(conf.dataDir).toBe(dir);
		expect(conf.workspaceRoot).toBe(join(dir, "workspace"));
		expect(conf.token).toBe("explicit-token-0123456789-abcdef");
	});
});

describe("PIPAYA_TOKEN strength", () => {
	test("a short explicit token is refused at startup", () => {
		const d = mkdtempSync(join(tmpdir(), "pipaya-tok-"));
		try {
			expect(() => loadConfig({ PIPAYA_DATA_DIR: d, PIPAYA_TOKEN: "short" })).toThrow("at least");
			expect(loadConfig({ PIPAYA_DATA_DIR: d }).token.length).toBeGreaterThanOrEqual(24);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("reasoning strengths of a custom model", () => {
	const reasoning = (extra: object) => ({ ...body(), models: [{ id: "unknown-model-xyz", contextWindow: 8192, maxTokens: 1024, reasoning: true, vision: false, ...extra }] });
	const levelsOf = async (id: string) => (await api("GET", `/models?provider=${id}`)).body.models[0].thinkingLevels;

	test("not set: the default minimal..high", async () => {
		expect((await api("PUT", "/configuration/providers/lv-auto", reasoning({}))).status).toBe(200);
		expect(await levelsOf("lv-auto")).toEqual(["minimal", "low", "medium", "high"]);
	});
	test("set by the owner: exactly those, even beyond the default", async () => {
		expect((await api("PUT", "/configuration/providers/lv-own", reasoning({ thinkingLevels: ["low", "high", "max"] }))).status).toBe(200);
		expect(await levelsOf("lv-own")).toEqual(["low", "high", "max"]);
	});
	test("an unknown level is rejected", async () => {
		expect((await api("PUT", "/configuration/providers/lv-bad", reasoning({ thinkingLevels: ["ultra"] }))).status).toBe(400);
	});
});

describe("where a model's reasoning strengths come from", () => {
	const put = (id: string, models: object[]) => api("PUT", `/configuration/providers/${id}`, { ...body(), models: models.map((m) => ({ contextWindow: 8192, maxTokens: 1024, vision: false, ...m })) });

	test("a name found in the catalog reports the catalog id it matched", async () => {
		const r = await put("src-cat", [{ id: "gpt-5", reasoning: true }]);
		expect(r.status).toBe(200);
		expect(r.body.models[0].thinkingSource).toEqual({ kind: "catalog", catalogId: "openai/gpt-5", levels: ["minimal", "low", "medium", "high"] });
	});
	test("the owner's own list is reported as custom, an unknown name as default", async () => {
		const r = await put("src-other", [{ id: "unknown-model-xyz", reasoning: true, thinkingLevels: ["low", "max"] }, { id: "unknown-model-abc", reasoning: true }, { id: "plain", reasoning: false }]);
		expect(r.body.models.map((m: any) => m.thinkingSource)).toEqual([
			{ kind: "custom", levels: ["low", "max"] },
			{ kind: "default", levels: ["minimal", "low", "medium", "high"] },
			{ kind: "default", levels: [] },
		]);
	});
	test("GET /configuration reports the same", async () => {
		const found = (await api("GET", "/configuration")).body.providers.find((p: any) => p.id === "src-cat");
		expect(found.models[0].thinkingSource.catalogId).toBe("openai/gpt-5");
	});
});
