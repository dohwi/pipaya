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
const api = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { ...(auth ? { authorization: "Bearer test-token" } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-llm-"));
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

const light = { provider: "echo", model: ECHO_MODEL.id };

// Tests run in order: the first ones see the pristine server.
describe("model roles and /llm/complete", () => {
	test("both need the token", async () => {
		expect((await api("GET", "/model-roles", undefined, false)).status).toBe(401);
		expect((await api("PUT", "/model-roles", { roles: {} }, false)).status).toBe(401);
		expect((await api("POST", "/llm/complete", { input: "x" }, false)).status).toBe(401);
	});

	test("empty at first; completing without any model is a clear 400", async () => {
		expect((await api("GET", "/model-roles")).json).toEqual({ roles: {} });
		const r = await api("POST", "/llm/complete", { input: "hi" });
		expect(r.status).toBe(400);
		expect(r.json.error.message).toContain("no model");
	});

	test("a role cannot point at a model that does not exist", async () => {
		const r = await api("PUT", "/model-roles", { roles: { light } });
		expect(r.status).toBe(400);
		expect(r.json.error.message).toContain("unknown model");
		expect((await api("GET", "/model-roles")).json).toEqual({ roles: {} });
	});

	test("register a provider, then roles save, read back and are announced", async () => {
		expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
		const put = await api("PUT", "/model-roles", { roles: { light, "summary-fast": light } });
		expect(put.status).toBe(200);
		expect(put.json.roles.light).toEqual(light);
		expect((await api("GET", "/model-roles")).json.roles["summary-fast"]).toEqual(light);
		const ev = app.bus.history({ after: 0, limit: 500 }).filter((e) => e.type === "configuration_updated" && (e.data as any).scope === "model-roles");
		expect(ev.length).toBe(1);
	});

	test("role names and counts are validated", async () => {
		for (const bad of ["Light", "1x", "has space", "", "a".repeat(41)]) {
			expect((await api("PUT", "/model-roles", { roles: { [bad]: light } })).status).toBe(400);
		}
		const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`r${i}`, light]));
		expect((await api("PUT", "/model-roles", { roles: many })).status).toBe(400);
		expect((await api("GET", "/model-roles")).json.roles.light).toEqual(light); // failed writes change nothing
	});

	test("complete by role returns text, usage and which model answered", async () => {
		const r = await api("POST", "/llm/complete", { role: "light", input: "hello" });
		expect(r.status).toBe(200);
		expect(r.json.text).toBe("Echo: hello");
		expect(r.json).toMatchObject({ provider: "echo", model: ECHO_MODEL.id, role: "light", stopReason: "stop" });
		expect(r.json.usage.totalTokens).toBeGreaterThan(0);
	});

	test("the system prompt and the output cap reach the upstream; no tools are offered", async () => {
		upstream.requests.length = 0;
		await api("POST", "/llm/complete", { role: "light", system: "Be brief.", input: "sum", maxTokens: 77 });
		const body = upstream.requests.at(-1)!.body;
		expect(body.messages[0]).toMatchObject({ role: "system" });
		expect(JSON.stringify(body.messages[0])).toContain("Be brief.");
		expect(body.messages.at(-1)).toMatchObject({ role: "user", content: "sum" });
		expect(body.tools ?? []).toEqual([]);
		expect(JSON.stringify(body)).toContain("77");
	});

	test("an unmapped role falls back to the default model; explicit provider+model also works", async () => {
		expect((await api("PUT", "/configuration/defaults", light)).status).toBe(200);
		const viaFallback = await api("POST", "/llm/complete", { role: "nobody-mapped", input: "a" });
		expect(viaFallback.status).toBe(200);
		expect(viaFallback.json.text).toBe("Echo: a");
		const explicit = await api("POST", "/llm/complete", { ...light, input: "b" });
		expect(explicit.json).toMatchObject({ text: "Echo: b", role: null });
	});

	test("bad requests are refused before any model call", async () => {
		upstream.requests.length = 0;
		const bad: unknown[] = [
			{ input: "" },
			{ input: "x", provider: "echo" }, // provider without model
			{ input: "x", role: "light", ...light }, // role and explicit model together
			{ input: "x", provider: "echo", model: "missing" },
			{ input: "x", maxTokens: 0 },
			{ input: "x", maxTokens: 999_999 },
			{ input: "x", role: "Bad Role" },
			{ input: "x", unknownField: 1 },
			{ input: "x".repeat(200_001) },
		];
		for (const b of bad) expect((await api("POST", "/llm/complete", b)).status).toBe(400);
		expect(upstream.requests.length).toBe(0);
	});

	test("clearing the table with an empty object removes every role", async () => {
		expect((await api("PUT", "/model-roles", { roles: {} })).json).toEqual({ roles: {} });
		expect((await api("GET", "/model-roles")).json).toEqual({ roles: {} });
	});
});
