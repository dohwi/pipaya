import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

// An image model is listed by the core and runs only through an extension's `registerModelRunner("image", …)`.
const IMG = { id: "img-model", name: "Img", contextWindow: 65536, maxTokens: 32768, reasoning: false, vision: true, imageGeneration: true };
const RUNNER = `
export default (pi) => {
	pi.registerModelRunner("image", async (req) => {
		const last = req.messages.filter((m) => m.role === "user").pop();
		const text = last.content.find((c) => c.type === "text").text;
		return { text: "drew " + text + " via " + req.model.id + " at " + req.model.baseUrl + " key " + (req.apiKey ?? "-"), usage: { input: 3, output: 4 } };
	});
};
`;

let app: App;
let dir: string;
let ws: string;
let extDir: string;
let upstream: EchoUpstream;
const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method, url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const idle = async (id: string) => {
	for (let i = 0; i < 300; i++) { if (!(await api("GET", `/sessions/${id}/status`)).json.running) return; await Bun.sleep(20); }
	throw new Error("never idle");
};
const imgModel = async () => (await api("GET", "/models?provider=up")).json.models.find((m: any) => m.id === IMG.id);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-runners-"));
	ws = join(dir, "ws");
	extDir = join(dir, "ext");
	mkdirSync(ws, { recursive: true });
	mkdirSync(extDir, { recursive: true });
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, extensionDirs: [extDir], home: dir });
	expect((await api("PUT", "/configuration/providers/up", { ...echoProviderBody(upstream.baseUrl), authRequired: true, models: [ECHO_MODEL, IMG] })).status).toBe(200);
	expect((await api("PUT", "/providers/up/credential", { key: "sk-up" })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("image models and model runners", () => {
	test("without a runner an image model is listed, not runnable, and a message to it is refused", async () => {
		expect(await imgModel()).toMatchObject({ imageGeneration: true, runnable: false });
		expect((await api("GET", "/models?provider=up")).json.models.find((m: any) => m.id === ECHO_MODEL.id).runnable).toBe(true);
		const id = (await api("POST", "/sessions", { cwd: ws, provider: "up", model: IMG.id })).json.id;
		const sent = await api("POST", `/sessions/${id}/messages`, { text: "a cat" });
		expect(sent.status).toBe(409);
		expect(sent.json.error.code).toBe("model_not_runnable");
		expect((await api("GET", `/sessions/${id}/messages`)).json.messages).toEqual([]);
	});

	test("an extension's runner answers with the connection's address and key", async () => {
		writeFileSync(join(extDir, "img.ts"), RUNNER);
		expect((await api("POST", "/server-extensions/reload")).status).toBe(200);
		expect((await api("GET", "/server-extensions")).json.extensions.find((e: any) => e.name === "img").modelRunners).toEqual(["image"]);
		expect(await imgModel()).toMatchObject({ runnable: true });
		const id = (await api("POST", "/sessions", { cwd: ws, provider: "up", model: IMG.id })).json.id;
		expect((await api("POST", `/sessions/${id}/messages`, { text: "a cat" })).status).toBe(202);
		await idle(id);
		const reply = (await api("GET", `/sessions/${id}/messages`)).json.messages.at(-1).message;
		expect(reply.stopReason).toBe("stop");
		expect(reply.content[0].text).toBe(`drew a cat via ${IMG.id} at ${upstream.baseUrl} key sk-up`);
		expect(reply.usage).toMatchObject({ input: 3, output: 4 });
		expect(upstream.requests.filter((r) => r.body?.model === IMG.id)).toEqual([]); // the runner, not the chat API, answered
	});

	test("a second extension cannot take the same kind", async () => {
		writeFileSync(join(extDir, "img2.ts"), RUNNER);
		await api("POST", "/server-extensions/reload");
		const list = (await api("GET", "/server-extensions")).json.extensions;
		expect(list.find((e: any) => e.name === "img").error).toBeUndefined();
		expect(list.find((e: any) => e.name === "img2").error).toContain("already run by img");
		rmSync(join(extDir, "img2.ts"));
		rmSync(join(extDir, "img.ts"));
		await api("POST", "/server-extensions/reload");
		expect(await imgModel()).toMatchObject({ runnable: false });
	});
});
