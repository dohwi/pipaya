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
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-system-role-"));
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

/** Saves a reasoning connection, sends one message and returns the role of the first upstream message. */
async function firstRole(id: string, extra: object): Promise<string> {
	const body = { ...echoProviderBody(upstream.baseUrl), ...extra, models: [{ ...ECHO_MODEL, reasoning: true }] };
	const put = await api("PUT", `/configuration/providers/${id}`, body); expect(put.status).toBe(200);
	const s = await api("POST", "/sessions", { provider: id, model: ECHO_MODEL.id, tools: [] });
	expect(s.status).toBe(201);
	const before = upstream.requests.length;
	expect((await api("POST", `/sessions/${s.json.id}/messages`, { text: "hi" })).status).toBe(202);
	await app.sessions.idle();
	return upstream.requests[before]!.body.messages[0].role;
}

describe("noDeveloperRole on a connection", () => {
	test("off (default): a reasoning model still gets the developer role", async () => {
		expect(await firstRole("dev-default", {})).toBe("developer");
	});

	test("on: the system prompt goes out as a system message", async () => {
		expect(await firstRole("dev-off", { noDeveloperRole: true })).toBe("system");
	});

	test("the flag is stored and returned, and must be a boolean", async () => {
		const saved = ((await api("GET", "/configuration")).json.providers ?? []) as { id: string; noDeveloperRole?: boolean }[];
		expect(saved.find((p) => p.id === "dev-off")?.noDeveloperRole).toBe(true);
		expect(saved.find((p) => p.id === "dev-default")?.noDeveloperRole).toBeUndefined();
		const bad = { ...echoProviderBody(upstream.baseUrl), noDeveloperRole: "yes" };
		expect((await api("PUT", "/configuration/providers/dev-bad", bad)).status).toBe(400);
	});
});
