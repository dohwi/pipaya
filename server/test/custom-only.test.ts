import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let upstream: EchoUpstream;
let base: string;
const auth = { authorization: "Bearer test-token-0123456789-abcdefghij" };

const api = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(base + path, {
		method,
		headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "harness-custom-only-"));
	upstream = startEchoUpstream();
	const cfg: Config = {
		host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token-0123456789-abcdefghij",
		workspaceRoot: join(dir, "ws"), defaultApproval: "auto", approvalTimeoutMs: 0, logLevel: "silent",
	};
	app = await buildApp(cfg, { strictResponses: true });
	await app.server.listen({ host: "0.0.0.0", port: 0 });
	base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
});

afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

// Tests run in order: the first ones observe the pristine server.
describe("custom-only catalog", () => {
	test("a fresh server has no providers, models or configuration", async () => {
		expect((await api("GET", "/providers")).json.providers).toEqual([]);
		expect((await api("GET", "/models")).json.models).toEqual([]);
		expect((await api("GET", "/models?configured=true")).json.models).toEqual([]);
		const config = (await api("GET", "/configuration")).json;
		expect(config.providers).toEqual([]);
		expect(config.defaults).toBeNull();
		expect(config.effectiveDefaults).toBeNull();
	});

	test("sessions cannot be created until a provider is configured", async () => {
		expect((await api("POST", "/sessions", {})).status).toBe(400);
		expect((await api("POST", "/sessions", { provider: "faux", model: "faux-1" })).status).toBe(400);
		expect((await api("POST", "/sessions", { provider: "openai", model: "gpt-4o" })).status).toBe(400);
		expect((await api("GET", "/sessions")).json.sessions).toEqual([]);
	});

	test("credentials for unknown providers are rejected with 404 and not stored", async () => {
		for (const id of ["openai", "faux", "nope"]) {
			expect((await api("PUT", `/providers/${id}/credential`, { key: "secret-key" })).status).toBe(404);
		}
		expect((await api("GET", "/providers")).json.providers).toEqual([]);
	});

	test("standard provider IDs are allowed for custom endpoints and sessions then work", async () => {
		for (const id of ["openai", "anthropic", "faux"]) {
			const saved = await api("PUT", `/configuration/providers/${id}`, echoProviderBody(upstream.baseUrl, `Custom ${id}`));
			expect(saved.status).toBe(200);
			expect(saved.json.id).toBe(id);
		}
		expect((await api("GET", "/providers")).json.providers.map((p: any) => p.id).sort()).toEqual(["anthropic", "faux", "openai"]);
		expect((await api("PUT", "/providers/openai/credential", { key: "k" })).status).toBe(200);

		const s = await api("POST", "/sessions", { provider: "openai", model: ECHO_MODEL.id, approval: "auto" });
		expect(s.status).toBe(201);
		expect((await api("POST", `/sessions/${s.json.id}/messages`, { text: "hi" })).status).toBe(202);
		await app.sessions.idle();
		const msgs = (await api("GET", `/sessions/${s.json.id}/messages`)).json.messages;
		expect(msgs.at(-1).message.content[0].text).toBe("Echo: hi");
		expect(upstream.requests.at(-1)!.authorization).toBe("Bearer k");
	});

	test("with a configured default, sessions are created without explicit model", async () => {
		expect((await api("PUT", "/configuration/defaults", { provider: "anthropic", model: ECHO_MODEL.id })).status).toBe(200);
		const s = await api("POST", "/sessions", {});
		expect(s.status).toBe(201);
		expect(s.json.provider).toBe("anthropic");
	});
});

describe("legacy environment is inert", () => {
	test("HARNESS_FAUX and provider API-key env vars register nothing; invalid env defaults are ignored", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "harness-env-"));
		const keys = { OPENAI_API_KEY: "sk-env-openai", ANTHROPIC_API_KEY: "sk-env-anthropic" };
		const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
		Object.assign(process.env, keys); // also visible to any ambient env-key discovery
		let app2: App | undefined;
		try {
			const cfg = loadConfig({
				HARNESS_DATA_DIR: dir2, HARNESS_TOKEN: "test-token-0123456789-abcdefghij", HARNESS_LOG_LEVEL: "silent", HARNESS_FAUX: "1", ...keys,
				HARNESS_PROVIDER: "openai", HARNESS_MODEL: "gpt-4o",
			});
			expect("enableFaux" in cfg).toBe(false);
			app2 = await buildApp(cfg, { strictResponses: true });
			const get = async (url: string) => (await app2!.server.inject({ method: "GET", url, headers: auth })).json();
			expect((await get("/providers")).providers).toEqual([]);
			expect((await get("/models")).models).toEqual([]);
			expect((await get("/models?configured=true")).models).toEqual([]);
			const config = await get("/configuration");
			expect(config.providers).toEqual([]);
			expect(config.effectiveDefaults).toBeNull();
			const created = await app2.server.inject({ method: "POST", url: "/sessions", headers: { ...auth, "content-type": "application/json" }, payload: "{}" });
			expect(created.statusCode).toBe(400);
			expect((await get("/sessions")).sessions).toEqual([]);
		} finally {
			await app2?.close();
			for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
