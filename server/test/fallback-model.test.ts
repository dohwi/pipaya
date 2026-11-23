import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
const FALLBACK = { id: "echo-fallback", name: "Echo fallback", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false };
const IMAGE_MODEL = { id: "echo-image", name: "Echo image", contextWindow: 4096, maxTokens: 1024, reasoning: false, vision: false, imageGeneration: true };

const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

let failPrimary = false;
beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-fallback-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	upstream = startEchoUpstream((body) => {
		if (failPrimary && body?.model === ECHO_MODEL.id) {
			return Response.json(
				{ error: { message: "upstream stream closed with zero output", type: "server_error", code: "internal_server_error" } },
				{ status: 502 },
			);
		}
		return undefined;
	});
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, home: join(dir, "home") });
	expect((await api("PUT", "/configuration/providers/echo", { ...echoProviderBody(upstream.baseUrl), models: [ECHO_MODEL, FALLBACK, IMAGE_MODEL] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
	expect((await api("PUT", "/configuration/delegate", { roles: "any", policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 })).status).toBe(200);
});

afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function untilIdle(id: string) {
	for (let i = 0; i < 600; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
}

describe("fallback model", () => {
	test("validates settings, rejects unknown or image models, and blocks deleting a provider in use", async () => {
		expect((await api("GET", "/fallback-model")).json).toEqual({ settings: { model: null }, defaults: { model: null } });
		expect((await api("PUT", "/fallback-model", { model: { provider: "echo", model: "nope" } })).status).toBe(400);
		expect((await api("PUT", "/fallback-model", { model: { provider: "echo", model: IMAGE_MODEL.id } })).status).toBe(400);
		expect((await api("PUT", "/fallback-model", {})).status).toBe(400);

		const saved = await api("PUT", "/fallback-model", { model: { provider: "echo", model: FALLBACK.id } });
		expect(saved.status).toBe(200);
		expect(saved.json.settings.model).toEqual({ provider: "echo", model: FALLBACK.id });

		const del = await api("DELETE", "/configuration/providers/echo");
		expect(del.status).toBe(409);
		expect(del.json.error.inUse.some((r: { role: string }) => r.role === "fallback")).toBe(true);

		expect((await api("PUT", "/fallback-model", { model: null })).json.settings.model).toBeNull();
	});

	test("switches to the fallback model after repeated zero-output failures without changing the session model", async () => {
		expect((await api("PUT", "/fallback-model", { model: { provider: "echo", model: FALLBACK.id } })).status).toBe(200);
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		upstream.requests.length = 0;
		failPrimary = true;

		// DEFAULT_UPSTREAM_RETRY caps zero-output at 2 retries (2s + 4s) + 1s fallback delay (~7s total).
		await api("POST", `/sessions/${id}/messages`, { text: "recover via fallback" });
		await untilIdle(id);

		const reqModels = upstream.requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => r.body.model);
		expect(reqModels).toEqual([ECHO_MODEL.id, ECHO_MODEL.id, ECHO_MODEL.id, FALLBACK.id]);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const assistant = msgs.filter((m) => m.role === "assistant").map((m) => m.message);
		expect(assistant).toHaveLength(1);
		expect(assistant[0].stopReason).toBe("stop");
		expect(assistant[0].model).toBe(FALLBACK.id);
		expect(JSON.stringify(assistant[0].content)).toContain("Echo: recover via fallback");

		// The session still keeps its primary model and uses it on the next turn once healthy again.
		expect((await api("GET", `/sessions/${id}`)).json.model).toBe(ECHO_MODEL.id);
		failPrimary = false;
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "back to primary" });
		await untilIdle(id);
		expect(upstream.requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => r.body.model)).toEqual([ECHO_MODEL.id]);
	}, { timeout: 20_000 });

	test("subagent delegate falls back on repeated zero-output failures too", async () => {
		expect((await api("PUT", "/fallback-model", { model: { provider: "echo", model: FALLBACK.id } })).status).toBe(200);
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		upstream.requests.length = 0;
		failPrimary = true;
		await api("PATCH", `/sessions/${id}`, { model: FALLBACK.id });
		await api("PUT", "/configuration/delegate", { roles: "any", policy: "allowlist", models: [`echo/${ECHO_MODEL.id}`], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 });
		// Parent runs on FALLBACK (so parent succeeds), and `!delegate` calls ECHO_MODEL which fails with zero-output and falls back to FALLBACK.
		await api("POST", `/sessions/${id}/messages`, { text: `!delegate {"role":"explore","task":"check files","model":"echo/${ECHO_MODEL.id}"}` });
		await untilIdle(id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const toolRes = msgs.find((m) => m.role === "toolResult")?.message;
		expect(toolRes?.isError).toBe(false);
		expect(toolRes?.details?.model).toBe(`echo/${FALLBACK.id}`);
		expect(JSON.stringify(toolRes?.content)).toContain("Echo: check files");
		failPrimary = false;
	}, { timeout: 20_000 });
});
