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
	dir = mkdtempSync(join(tmpdir(), "pipaya-custom-only-"));
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
describe("built-in + custom catalog", () => {
	test("a fresh server lists the SDK's built-in providers, none usable yet, and no configuration", async () => {
		const providers = (await api("GET", "/providers")).json.providers;
		const ids = providers.map((p: any) => p.id);
		for (const id of ["openai", "anthropic", "google", "openrouter", "github-copilot"]) expect(ids).toContain(id);
		expect(providers.every((p: any) => p.builtin)).toBe(true);
		expect(providers.find((p: any) => p.id === "anthropic").loginMethods).toContain("oauth");
		expect(providers.find((p: any) => p.id === "openai").loginMethods).toContain("oauth");
		expect((await api("GET", "/models")).json.models.length).toBeGreaterThan(100);
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
		for (const id of ["faux", "nope"]) {
			expect((await api("PUT", `/providers/${id}/credential`, { key: "secret-key" })).status).toBe(404);
		}
		expect((await api("GET", "/providers")).json.providers.map((p: any) => p.id)).not.toContain("nope");
		expect((await api("POST", "/providers/nope/login", { type: "oauth" })).status).toBe(404);
		expect((await api("POST", "/providers/deepseek/login", { type: "oauth" })).status).toBe(400); // no OAuth for this one
		expect((await api("GET", "/logins/unknown")).status).toBe(404);
	});

	test("standard provider IDs are allowed for custom endpoints and sessions then work", async () => {
		for (const id of ["openai", "anthropic", "faux"]) {
			const saved = await api("PUT", `/configuration/providers/${id}`, echoProviderBody(upstream.baseUrl, `Custom ${id}`));
			expect(saved.status).toBe(200);
			expect(saved.json.id).toBe(id);
		}
		const listed = (await api("GET", "/providers")).json.providers;
		expect(listed.find((p: any) => p.id === "faux").builtin).toBe(false);
		expect(listed.find((p: any) => p.id === "openai").builtin).toBe(false); // the custom endpoint shadows the built-in one
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

describe("legacy environment", () => {
	test("PIPAYA_FAUX registers nothing; a default naming an unusable model is ignored", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "pipaya-env-"));
		const keys = { OPENAI_API_KEY: "sk-env-openai", ANTHROPIC_API_KEY: "sk-env-anthropic" };
		const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
		Object.assign(process.env, keys); // also visible to any ambient env-key discovery
		let app2: App | undefined;
		try {
			const cfg = loadConfig({
				PIPAYA_DATA_DIR: dir2, PIPAYA_TOKEN: "test-token-0123456789-abcdefghij", PIPAYA_LOG_LEVEL: "silent", PIPAYA_FAUX: "1", ...keys,
				PIPAYA_PROVIDER: "openai", PIPAYA_MODEL: "gpt-4o",
			});
			expect("enableFaux" in cfg).toBe(false);
			app2 = await buildApp(cfg, { strictResponses: true });
			const get = async (url: string) => (await app2!.server.inject({ method: "GET", url, headers: auth })).json();
			expect((await get("/providers")).providers.map((p: any) => p.id)).not.toContain("faux");
			const config = await get("/configuration");
			expect(config.providers).toEqual([]);
			expect(config.effectiveDefaults).toEqual({ provider: "openai", model: "gpt-4o" }); // OPENAI_API_KEY from the environment is honored by the SDK
		} finally {
			await app2?.close();
			for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
