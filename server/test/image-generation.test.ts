import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, ECHO_PNG, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

// Image models never chat. With one set as the image model, agents get `generate_image`, which saves the picture.
const IMG = { id: "img-model", name: "Img", contextWindow: 65536, maxTokens: 32768, reasoning: false, vision: true, imageGeneration: true };

let app: App;
let dir: string;
let ws: string;
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
const toolNames = async () => (await api("GET", "/tools")).json.tools.map((t: any) => t.name) as string[];

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-imggen-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, home: dir });
	expect((await api("PUT", "/configuration/providers/up", { ...echoProviderBody(upstream.baseUrl), models: [ECHO_MODEL, IMG] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "up", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("image models", () => {
	test("never run a chat", async () => {
		expect((await api("POST", "/sessions", { cwd: ws, provider: "up", model: IMG.id })).json.error.code).toBe("image_model_not_chat");
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id;
		expect((await api("PATCH", `/sessions/${id}`, { provider: "up", model: IMG.id })).status).toBe(409);
		expect((await api("PUT", "/configuration/defaults", { provider: "up", model: IMG.id })).status).toBe(400);
	});

	test("the image model setting takes only image models; generate_image exists only while one is set", async () => {
		expect((await api("GET", "/image-model")).json.settings).toEqual({ model: null });
		expect(await toolNames()).not.toContain("generate_image");
		expect((await api("PUT", "/image-model", { model: { provider: "up", model: ECHO_MODEL.id } })).status).toBe(400);
		expect((await api("PUT", "/image-model", { model: { provider: "up", model: IMG.id } })).status).toBe(200);
		expect(await toolNames()).toContain("generate_image");
		expect((await api("GET", "/configuration")).json.tools.toggleable).toContain("generate_image");
	});

	test("an agent draws with generate_image and edits a picture by path", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id;
		writeFileSync(join(ws, "ref.png"), Buffer.from(ECHO_PNG, "base64"));
		expect((await api("POST", `/sessions/${id}/messages`, { text: `!generate_image {"prompt":"a red cat","images":["ref.png"]}` })).status).toBe(202);
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		const result = msgs.find((m: any) => m.role === "toolResult");
		expect(result.isError).toBe(false);
		const path = result.details.paths[0] as string;
		expect(path).toMatch(/^\.pipaya\/generated\/.+\.png$/);
		expect(readFileSync(join(ws, path)).toString("base64")).toBe(ECHO_PNG);
		expect(result.content.map((c: any) => c.type)).toEqual(["text", "image"]);
		// the result line itself tells the model to embed the picture in its reply
		expect(result.content[0].text).toContain(`Saved ${path} (show it in your reply with ![description](path), then describe it briefly)`);
		const sent = upstream.requests.filter((r) => Array.isArray(r.body?.modalities)).at(-1)!;
		expect(sent.body.model).toBe(IMG.id);
		expect(sent.body.messages[0].content.map((c: any) => c.type)).toEqual(["text", "image_url"]);
	});

	test("switched off, or with the image model unset, the tool is gone", async () => {
		expect((await api("PUT", "/configuration/tools", { disabled: ["generate_image"] })).status).toBe(200);
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id;
		await api("POST", `/sessions/${id}/messages`, { text: `!generate_image {"prompt":"x"}` });
		await idle(id);
		const result = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message).find((m: any) => m.role === "toolResult");
		expect(result.isError).toBe(true);
		expect((await api("PUT", "/configuration/tools", { disabled: [] })).status).toBe(200);
		expect((await api("PUT", "/image-model", { model: null })).status).toBe(200);
		expect(await toolNames()).not.toContain("generate_image");
		expect(existsSync(join(ws, ".pipaya", "generated"))).toBe(true);
	});
});
