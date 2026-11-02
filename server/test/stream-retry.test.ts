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
	dir = mkdtempSync(join(tmpdir(), "pipaya-stream-retry-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function untilIdle(id: string) {
	for (let i = 0; i < 500; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
}

describe("a stream cut off mid-reply", () => {
	// The wait before the retry is real (2s): this test costs a couple of seconds on purpose.
	test("is dropped and the request repeated, so the run ends with the retried answer", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!drop hello" });
		await untilIdle(id);

		// Two requests: the one that was cut, then the retry that answered.
		expect(upstream.requests.filter((r) => r.path.endsWith("/chat/completions"))).toHaveLength(2);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const assistant = msgs.filter((m) => m.role === "assistant").map((m) => m.message);
		expect(assistant).toHaveLength(1); // the half-written reply is not kept
		expect(assistant[0].stopReason).toBe("stop");
		expect(JSON.stringify(assistant[0].content)).toContain("Echo: hello");
		expect((await api("GET", `/sessions/${id}/status`)).json.lastError).toBeNull();
	});
});
