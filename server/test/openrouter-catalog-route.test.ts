import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";

/**
 * The settings screens autocomplete model ids from OpenRouter's own list (GET /configuration/catalog). It is fetched
 * live and cached, so a model OpenRouter added after this server was built is still offered.
 */

let app: App;
let dir: string;
let upstream: ReturnType<typeof Bun.serve>;
let saved: string | undefined;
let savedEnabled: string | undefined;

const TOKEN = "catalog-test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
	saved = process.env.PIPAYA_OPENROUTER_URL;
	// test/setup.ts turns live fetching off for the whole run; this file is about it, so it turns it back on.
	savedEnabled = process.env.PIPAYA_OPENROUTER;
	process.env.PIPAYA_OPENROUTER = "1";
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/api/v1/images/models") return Response.json({ data: [] });
			if (path === "/api/v1/models/anthropic/claude-fable-5.2/endpoints") return Response.json({ data: { endpoints: [{ service_tier: null }, { service_tier: "priority" }] } });
			if (path !== "/api/v1/models") return new Response("not found", { status: 404 });
			return Response.json({
				data: [{
					id: "anthropic/claude-fable-5.2",
					name: "Anthropic: Claude Fable 5.2",
					context_length: 1_000_000,
					architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
					top_provider: { max_completion_tokens: 128_000 },
					reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high", "xhigh", "max"] },
				}],
			});
		},
	});
	process.env.PIPAYA_OPENROUTER_URL = `http://127.0.0.1:${upstream.port}/api/v1/models`;
	dir = mkdtempSync(join(tmpdir(), "pipaya-catalog-route-"));
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "test.db"), token: TOKEN, workspaceRoot: join(dir, "ws"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, extensionDirs: [] });
});

afterAll(async () => {
	await app.close();
	upstream.stop(true);
	if (saved === undefined) delete process.env.PIPAYA_OPENROUTER_URL;
	else process.env.PIPAYA_OPENROUTER_URL = saved;
	if (savedEnabled === undefined) delete process.env.PIPAYA_OPENROUTER;
	else process.env.PIPAYA_OPENROUTER = savedEnabled;
	rmSync(dir, { recursive: true, force: true });
});

const get = async (url: string) => (await app.server.inject({ method: "GET", url, headers: auth })).json();

test("the catalog route serves OpenRouter's own list, with how current it is", async () => {
	const r = await get("/configuration/catalog");
	expect(r.live).toBe(true);
	expect(r.stale).toBe(false);
	expect(r.error).toBeUndefined();
	expect(r.updatedAt).toBeGreaterThan(0);
	const fable = r.models.find((m: any) => m.id === "anthropic/claude-fable-5.2");
	expect(fable).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true, image: false });
	// mandatory reasoning: "off" is not offered
	expect(fable.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("refresh=1 fetches again", async () => {
	const before = (await get("/configuration/catalog")).updatedAt;
	await Bun.sleep(5);
	const r = await get("/configuration/catalog?refresh=1");
	expect(r.updatedAt).toBeGreaterThan(before);
	expect(r.live).toBe(true);
});

test("a model registered by name takes its limits and strengths from the live list", async () => {
	const body = {
		name: "Local", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", authRequired: false,
		models: [{ id: "claude-fable-5.2", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, vision: true }],
	};
	const saved = await app.server.inject({ method: "PUT", url: "/configuration/providers/live", headers: auth, payload: body });
	expect(saved.statusCode).toBe(200);
	const model = saved.json().models[0];
	expect(model.thinkingSource).toEqual({ kind: "catalog", catalogId: "anthropic/claude-fable-5.2", levels: ["low", "medium", "high", "xhigh", "max"] });
});

test("only direct OpenRouter chats can save advertised tiers; default, reset and model switches survive reload", async () => {
	const call = async (method: "POST" | "PUT" | "PATCH", url: string, payload: object) => app.server.inject({ method, url, headers: auth, payload });
	const id = "anthropic/claude-fable-5.2";
	const base = { name: "Router", api: "openai-completions", authRequired: false, models: [{ id, contextWindow: 10000, maxTokens: 200, reasoning: true, vision: false }] };
	const router = { provider: "tier-router", model: id };
	const proxy = { provider: "tier-proxy", model: id };
	await get("/configuration/catalog");
	expect(await get(`/configuration/catalog/tiers?model=${id}`)).toEqual({ tiers: ["priority"] });
	for (const [provider, baseUrl] of [[router.provider, "https://openrouter.ai/api/v1"], [proxy.provider, "http://127.0.0.1:9/v1"]] as const) {
		expect((await call("PUT", `/configuration/providers/${provider}`, { ...base, baseUrl })).statusCode).toBe(200);
	}
	expect((await call("PUT", "/configuration/defaults", { ...router, serviceTier: "priority", thinkingLevel: "high" })).statusCode).toBe(200);
	const session = (await call("POST", "/sessions", {})).json();
	expect(session).toMatchObject({ ...router, serviceTier: "priority", thinkingLevel: "high" });
	const path = `/sessions/${session.id}`;
	expect((await call("PATCH", path, { serviceTier: "ultrafast" })).statusCode).toBe(400);
	expect((await get(path)).serviceTier).toBe("priority");
	expect((await call("PATCH", path, { serviceTier: null })).json().serviceTier).toBeNull();
	expect((await call("PATCH", path, { serviceTier: "priority" })).json().serviceTier).toBe("priority");
	expect((await call("PATCH", path, proxy)).json().serviceTier).toBeNull();
	expect((await call("PATCH", path, { serviceTier: "priority" })).statusCode).toBe(400);
	// Back on the router model the chat starts at the speed a new chat with it would: the saved new-chat choice.
	expect((await call("PATCH", path, router)).json().serviceTier).toBe("priority");
	expect((await call("PATCH", path, proxy)).json().serviceTier).toBeNull();
	expect((await call("PUT", "/configuration/defaults", { ...proxy, serviceTier: "priority" })).statusCode).toBe(400);
	expect((await get(path)).serviceTier).toBeNull();
});

test("new chats snapshot the chosen speed: explicit session > new-chat setting > model default > workspace", async () => {
	const call = async (method: "POST" | "PUT" | "PATCH", url: string, payload: object) => app.server.inject({ method, url, headers: auth, payload });
	const id = "anthropic/claude-fable-5.2", provider = "starting-speed";
	const selection = { provider, model: id, thinkingLevel: "high" };
	const model = { id, contextWindow: 10000, maxTokens: 200, reasoning: true, vision: false, defaultServiceTier: "priority" };
	const conn = { name: "Router", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", authRequired: false, models: [model] };
	const save = (body: object) => call("PUT", `/configuration/providers/${provider}`, body);
	const defaults = (body: object) => call("PUT", "/configuration/defaults", body);
	const create = async (body = {}) => { const r = await call("POST", "/sessions", body); expect(r.statusCode).toBe(201); return r.json(); };
	await get("/configuration/catalog");
	expect((await save(conn)).json().models[0].defaultServiceTier).toBe("priority");
	const inherited = (await defaults(selection)).json();
	expect(inherited.defaults.serviceTier).toBeUndefined();
	expect(inherited.effectiveDefaults.serviceTier).toBe("priority");
	const existing = await create();
	expect(existing).toMatchObject({ serviceTier: "priority", thinkingLevel: "high" });
	expect((await defaults({ ...selection, serviceTier: "default" })).json().effectiveDefaults.serviceTier).toBe("default");
	expect(await create()).toMatchObject({ serviceTier: "default", thinkingLevel: "high" });
	expect((await create({ serviceTier: null })).serviceTier).toBeNull();
	expect((await create({ serviceTier: "priority" })).serviceTier).toBe("priority");
	expect((await get(`/sessions/${existing.id}`)).serviceTier).toBe("priority");
	expect((await defaults({ ...selection, serviceTier: null })).json().effectiveDefaults.serviceTier).toBeNull();
	expect((await create()).serviceTier).toBeNull();
	await defaults(selection);
	expect((await save({ ...conn, models: [{ ...model, defaultServiceTier: "default" }] })).statusCode).toBe(200);
	expect((await create()).serviceTier).toBe("default");
	for (const body of [{ ...conn, baseUrl: "https://proxy.invalid/v1" }, { ...conn, models: [{ ...model, imageGeneration: true }] }, { ...conn, models: [{ ...model, defaultServiceTier: "ultrafast" }] }]) {
		expect((await save(body)).statusCode).toBe(400);
	}
	expect((await call("PATCH", `/sessions/${existing.id}`, { serviceTier: "default" })).json().serviceTier).toBe("default");
	// Switching a chat to a model follows the same order as a new chat: an explicit speed, else the new-chat choice for
	// that model, else the model's own default. Switching to a model with neither leaves OpenRouter's own routing.
	const other = "other-speed";
	expect((await call("PUT", `/configuration/providers/${other}`, { ...conn, models: [{ ...model, defaultServiceTier: "priority" }] })).statusCode).toBe(200);
	const switched = `/sessions/${existing.id}`;
	expect((await call("PATCH", switched, { provider: other, model: id })).json().serviceTier).toBe("priority");
	expect((await call("PATCH", switched, { provider, model: id, serviceTier: null })).json().serviceTier).toBeNull();
	expect((await call("PATCH", switched, { provider: other, model: id })).json().serviceTier).toBe("priority");
	expect((await call("PATCH", switched, { provider, model: id })).json().serviceTier).toBe("default");
	// A connection whose id sounds like OpenRouter still cannot pin a tier on a different transport.
	const shadow = "openrouter-shadow";
	expect((await call("PUT", `/configuration/providers/${shadow}`, { ...conn, baseUrl: "http://127.0.0.1:9/v1", models: [{ id, contextWindow: 10000, maxTokens: 200, reasoning: false, vision: false }] })).statusCode).toBe(200);
	expect((await call("POST", "/sessions", { provider: shadow, model: id, serviceTier: "default" })).statusCode).toBe(400);
});

test("a proxy model takes only the speeds its owner listed; other connections and formats refuse a list", async () => {
	const call = async (method: "POST" | "PUT" | "PATCH", url: string, payload: object) => app.server.inject({ method, url, headers: auth, payload });
	const model = { id: "gpt-proxy", contextWindow: 10000, maxTokens: 200, reasoning: true, vision: false };
	const conn = (models: object[], extra: object = {}) => ({ name: "Proxy", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", authRequired: false, models, ...extra });
	const save = (body: object) => call("PUT", "/configuration/providers/tier-cpa", body);
	const saved = await save(conn([{ ...model, serviceTiers: ["priority"], defaultServiceTier: "priority" }]));
	expect(saved.statusCode).toBe(200);
	expect(saved.json().models[0]).toMatchObject({ serviceTiers: ["priority"], defaultServiceTier: "priority" });
	expect((await get("/models?provider=tier-cpa")).models[0]).toMatchObject({ serviceTiers: ["priority"], defaultServiceTier: "priority" });
	const session = (await call("POST", "/sessions", { provider: "tier-cpa", model: model.id })).json();
	expect(session.serviceTier).toBe("priority");
	const path = `/sessions/${session.id}`;
	expect((await call("PATCH", path, { serviceTier: "default" })).json().serviceTier).toBe("default");
	expect((await call("PATCH", path, { serviceTier: "ultrafast" })).statusCode).toBe(400);
	expect((await call("PUT", "/configuration/defaults", { provider: "tier-cpa", model: model.id, serviceTier: "priority" })).statusCode).toBe(200);
	for (const body of [
		conn([{ ...model, defaultServiceTier: "priority" }]),
		conn([{ ...model, serviceTiers: ["priority"], defaultServiceTier: "ultrafast" }]),
		conn([{ ...model, serviceTiers: ["priority"], imageGeneration: true }]),
		conn([{ ...model, serviceTiers: ["priority"] }], { api: "anthropic-messages" }),
		conn([{ ...model, serviceTiers: ["priority"] }], { baseUrl: "https://openrouter.ai/api/v1" }),
	]) expect((await save(body)).statusCode).toBe(400);
	await call("PUT", "/configuration/defaults", { provider: "tier-cpa", model: model.id });
	// Dropping the list takes the speed back: the chat keeps its record but the model no longer takes one.
	expect((await save(conn([model]))).statusCode).toBe(200);
	expect((await get("/models?provider=tier-cpa")).models[0]).not.toHaveProperty("serviceTiers");
	expect((await call("PATCH", path, { serviceTier: "default" })).statusCode).toBe(400);
});

test("a subagent runs at its session's speed on the same model, else at its own model's default, never at a proxy's", async () => {
	const call = async (method: "POST" | "PUT", url: string, payload: object) => app.server.inject({ method, url, headers: auth, payload });
	const id = "anthropic/claude-fable-5.2";
	const model = { id, contextWindow: 10000, maxTokens: 200, reasoning: true, vision: false };
	const conn = (baseUrl: string, models: object[]) => ({ name: "Sub", baseUrl, api: "openai-completions", authRequired: false, models });
	expect((await call("PUT", "/configuration/providers/sub-fast", conn("https://openrouter.ai/api/v1", [{ ...model, defaultServiceTier: "priority" }]))).statusCode).toBe(200);
	expect((await call("PUT", "/configuration/providers/sub-plain", conn("https://openrouter.ai/api/v1", [model]))).statusCode).toBe(200);
	expect((await call("PUT", "/configuration/providers/sub-proxy", conn("http://127.0.0.1:9/v1", [model]))).statusCode).toBe(200);
	const session = (await call("POST", "/sessions", { provider: "sub-plain", model: id, serviceTier: "default" })).json();
	const rec = app.sessions.get(session.id);
	const tierOf = (provider: string) => (app.sessions as unknown as { subagentTier(r: unknown, p: string, m: string): unknown }).subagentTier(rec, provider, id);
	expect(tierOf("sub-plain")).toBe("default");
	expect(tierOf("sub-fast")).toBe("priority");
	expect(tierOf("sub-proxy")).toBeNull();
});
