import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";

let app: App;
let dir: string;
let upstream: ReturnType<typeof Bun.serve>;
let cfg: Config;
let listed: string[] = ["alpha", "beta"];
const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({ method, url, headers: { authorization: "Bearer test-token" }, ...(payload === undefined ? {} : { payload: payload as any }) });
	return { status: r.statusCode, body: r.json() };
};
const model = (id: string, extra = {}) => ({ id, contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false, ...extra });

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-refresh-"));
	upstream = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => Response.json({ data: listed.map((id) => ({ id })) }) });
	cfg = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "workspace"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => { await app.close(); upstream.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("live model list", () => {
	test("new upstream models appear, removed ones are flagged unavailable, an unreachable upstream changes nothing", async () => {
		const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
		const put = await api("PUT", "/configuration/providers/live", {
			name: "Live", baseUrl, api: "openai-completions", authRequired: false,
			models: [model("alpha", { fromUpstream: true }), model("beta", { fromUpstream: true }), model("manual")],
		});
		expect(put.status).toBe(200);
		const state = async () => Object.fromEntries((await api("GET", "/models?provider=live")).body.models.map((m: any) => [m.id, m.available]));
		const wait = () => new Promise((r) => setTimeout(r, 150));

		listed = ["alpha", "gamma"]; // beta removed, gamma new
		await api("GET", "/models?provider=live"); // triggers the background refresh
		await wait();
		expect(await state()).toEqual({ alpha: true, beta: false, gamma: true, manual: true });
		const cfgModels = (await api("GET", "/configuration")).body.providers[0].models;
		expect(cfgModels.find((m: any) => m.id === "beta").unavailable).toBe(true);
		expect(cfgModels.find((m: any) => m.id === "gamma").fromUpstream).toBe(true);
	});

	test("the refresh endpoint reads the list now, flags models the upstream lacks and reports failures", async () => {
		const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
		listed = ["one"];
		expect((await api("PUT", "/configuration/providers/now", { name: "Now", baseUrl, api: "openai-completions", authRequired: false, models: [model("typed")] })).status).toBe(200);
		listed = ["one", "two"];
		const r = await api("POST", "/configuration/providers/now/refresh");
		expect(r.status).toBe(200);
		const rows = (body: any) => body.models.map((m: any) => [m.id, m.unavailable ?? false, m.fromUpstream ?? false]);
		expect(rows(r.body)).toEqual([["typed", false, false], ["one", false, true], ["two", false, true]]);
		listed = ["typed", "two"]; // the typed model is adopted, "one" is gone
		expect(rows((await api("POST", "/configuration/providers/now/refresh")).body)).toEqual([["typed", false, true], ["one", true, true], ["two", false, true]]);
		listed = ["typed", "one", "two"];
		expect((await api("POST", "/configuration/providers/now/refresh")).body.models.some((m: any) => m.unavailable)).toBe(false);

		expect((await api("POST", "/configuration/providers/missing/refresh")).status).toBe(404);
		await api("PUT", "/configuration/providers/dead", { name: "Dead", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", authRequired: false, models: [] });
		expect((await api("POST", "/configuration/providers/dead/refresh")).status).toBe(400);
		await api("PUT", "/configuration/providers/keyed", { name: "Keyed", baseUrl, api: "openai-completions", authRequired: true, models: [] });
		expect((await api("POST", "/configuration/providers/keyed/refresh")).status).toBe(400);
	});

	test("a restarted server reads every connection's model list on its own", async () => {
		listed = ["one", "two", "three"];
		await app.close();
		app = await buildApp(cfg, { strictResponses: true });
		for (let i = 0; i < 40; i++) {
			const ids = (await app.server.inject({ method: "GET", url: "/configuration", headers: { authorization: "Bearer test-token" } })).json()
				.providers.find((p: any) => p.id === "now").models.map((m: any) => m.id);
			if (ids.includes("three")) return;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error("startup refresh did not add the new model");
	});
});
