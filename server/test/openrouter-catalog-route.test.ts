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
