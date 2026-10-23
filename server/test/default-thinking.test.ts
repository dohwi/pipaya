import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let upstream: EchoUpstream;
const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: payload === null ? "null" : JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-default-thinking-"));
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

const model = { provider: "echo", model: ECHO_MODEL.id };

describe("server default model carries a thinking level", () => {
	test("a model alone still works, and no thinking level is stored", async () => {
		const r = await api("PUT", "/configuration/defaults", model);
		expect(r.status).toBe(200);
		expect(r.json.defaults).toEqual(model);
		expect(r.json.effectiveDefaults).toEqual(model);
	});

	test("model + thinking level is saved, returned by both fields and by GET /configuration", async () => {
		const r = await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "high" });
		expect(r.status).toBe(200);
		expect(r.json.defaults).toEqual({ ...model, thinkingLevel: "high" });
		expect(r.json.effectiveDefaults).toEqual({ ...model, thinkingLevel: "high" });
		const cfg = (await api("GET", "/configuration")).json;
		expect(cfg.defaults.thinkingLevel).toBe("high");
		expect(cfg.effectiveDefaults.thinkingLevel).toBe("high");
	});

	test("every real level is accepted; 'off' and anything else is refused and changes nothing", async () => {
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect((await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: level })).status).toBe(200);
		}
		await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "low" });
		for (const bad of ["off", "extreme", "", null, 3]) {
			expect((await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: bad })).status).toBe(400);
		}
		expect((await api("PUT", "/configuration/defaults", { ...model, other: 1 })).status).toBe(400);
		expect((await api("GET", "/configuration")).json.defaults.thinkingLevel).toBe("low");
	});

	test("a new session starts at the default thinking level", async () => {
		await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "xhigh" });
		const s = (await api("POST", "/sessions", {})).json;
		expect(s.thinkingLevel).toBe("xhigh");
		expect((await api("GET", `/sessions/${s.id}`)).json.thinkingLevel).toBe("xhigh");
	});

	test("a level given when creating the session wins over the default", async () => {
		await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "xhigh" });
		expect((await api("POST", "/sessions", { thinkingLevel: "low" })).json.thinkingLevel).toBe("low");
	});

	test("with no default level a new session starts at medium, as before", async () => {
		await api("PUT", "/configuration/defaults", model);
		expect((await api("POST", "/sessions", {})).json.thinkingLevel).toBe("medium");
	});

	test("changing the default does not touch sessions that already exist", async () => {
		await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "low" });
		const s = (await api("POST", "/sessions", {})).json;
		await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "max" });
		expect((await api("GET", `/sessions/${s.id}`)).json.thinkingLevel).toBe("low");
	});

	test("an unknown model is still refused, with or without a level", async () => {
		expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: "nope", thinkingLevel: "high" })).status).toBe(400);
		expect((await api("PUT", "/configuration/defaults", { provider: "nope", model: "x" })).status).toBe(400);
	});

	test("null clears both the model and its thinking level", async () => {
		await api("PUT", "/configuration/defaults", { ...model, thinkingLevel: "high" });
		const r = await api("PUT", "/configuration/defaults", null);
		expect(r.status).toBe(200);
		expect(r.json.defaults).toBeNull();
		expect((await api("GET", "/configuration")).json.defaults).toBeNull();
	});

	test("a default saved before this field existed (no level) keeps working", async () => {
		await api("PUT", "/configuration/defaults", model);
		const cfg = (await api("GET", "/configuration")).json;
		expect(cfg.defaults).toEqual(model);
		expect("thinkingLevel" in cfg.defaults).toBe(false);
		expect((await api("POST", "/sessions", {})).status).toBe(201);
	});
});
