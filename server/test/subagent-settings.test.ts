import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THINKING_LEVELS } from "../src/store.ts";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { SubAgentSettings } from "../src/subagent-settings.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
const LIGHT = { id: "echo-light", name: "Echo light", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false };
const THINK = { ...LIGHT, id: "echo-think", name: "Echo think", reasoning: true };
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
	dir = mkdtempSync(join(tmpdir(), "pipaya-subagent-settings-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(ws, "a.txt"), "hello\n");
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, home: dir });
	expect((await api("PUT", "/configuration/providers/echo", { ...echoProviderBody(upstream.baseUrl), models: [ECHO_MODEL, LIGHT, THINK] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});


const AGENTS = () => join(dir, ".agents", "subagents");
/** Writes `<name>.md` into the global agents folder (the test home). */
const agentFile = (name: string, front: Record<string, unknown> = {}, prompt = "") => {
	mkdirSync(AGENTS(), { recursive: true });
	const lines = Object.entries({ description: "Searches", ...front }).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`);
	writeFileSync(join(AGENTS(), `${name}.md`), `---\n${lines.join("\n")}\n---\n${prompt}\n`);
};
const clearAgents = () => rmSync(AGENTS(), { recursive: true, force: true });
const list = async () => (await api("GET", "/subagents")).json;
const sw = (enabled: boolean) => api("PUT", "/subagents", { enabled });
const swAgent = (name: string, enabled: boolean) => api("PUT", `/subagents/${name}`, { enabled });
async function untilIdle(id: string) {
	for (let i = 0; i < 300; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
}
const newSession = async () => (await api("POST", "/sessions", { cwd: ws, approval: "auto" })).json.id as string;
const delegate = async (id: string, args: object) => {
	upstream.requests.length = 0;
	await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify(args)}` });
	await untilIdle(id);
	const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
	return msgs.map((m) => m.message).filter((m) => m.role === "toolResult" && m.toolName === "delegate").at(-1);
};
const helperRequest = () => upstream.requests.find((r) => JSON.stringify(r.body?.messages?.[0]).includes("read-only research assistant"));
const reset = async () => {
	clearAgents();
	await sw(true);
	for (const n of ["explore", "deep", "off"]) await swAgent(n, true).catch(() => {});
};

describe("sub-agent API", () => {
	test("needs the token", async () => {
		expect((await api("GET", "/subagents", undefined, false)).status).toBe(401);
		expect((await api("PUT", "/subagents", { enabled: true }, false)).status).toBe(401);
		expect((await api("PUT", "/subagents/x", { enabled: true }, false)).status).toBe(401);
	});

	test("a fresh server has delegate on and no helper; writing tools can be offered to a helper", async () => {
		await reset();
		const r = await list();
		expect(r).toMatchObject({ enabled: true, agents: [], warnings: [] });
		expect(r.toolChoices).toEqual(["read", "grep", "ls", "write", "edit", "bash"]);
	});

	test("lists agent files with their settings, path and scope; broken files come back as warnings", async () => {
		await reset();
		agentFile("explore", { model: `echo/${LIGHT.id}`, thinking: "low", maxTurns: 7 }, "Be brief.");
		writeFileSync(join(AGENTS(), "broken.md"), "nothing");
		const r = await list();
		expect(r.agents).toHaveLength(1);
		expect(r.agents[0]).toMatchObject({
			name: "explore", description: "Searches", enabled: true, fileEnabled: true, scope: "global",
			model: { provider: "echo", model: LIGHT.id, thinkingLevel: "low" }, tools: ["read", "grep", "ls"], maxTurns: 7, prompt: "Be brief.",
			path: join(AGENTS(), "explore.md"),
		});
		expect(r.warnings.map((w: any) => w.path)).toEqual([join(AGENTS(), "broken.md")]);
		await reset();
	});

	test("the master switch and a per-helper switch are saved and announced", async () => {
		await reset();
		agentFile("explore");
		const before = app.bus.history({ after: 0, limit: 500 }).filter((e) => e.type === "configuration_updated" && (e.data as any).scope === "subagents").length;
		expect((await sw(false)).json.enabled).toBe(false);
		expect((await sw(true)).json.enabled).toBe(true);
		const off = await swAgent("explore", false);
		expect(off.status).toBe(200);
		expect(off.json.agents[0]).toMatchObject({ enabled: false, fileEnabled: true });
		expect((await list()).agents[0].enabled).toBe(false);
		expect((await swAgent("explore", true)).json.agents[0].enabled).toBe(true);
		const after = app.bus.history({ after: 0, limit: 500 }).filter((e) => e.type === "configuration_updated" && (e.data as any).scope === "subagents").length;
		expect(after - before).toBe(4);
		await reset();
	});

	test("a helper the file disables stays off; an unknown name is 404; bad bodies are 400", async () => {
		await reset();
		agentFile("explore", { enabled: false });
		expect((await swAgent("explore", true)).json.agents[0]).toMatchObject({ enabled: false, fileEnabled: false });
		expect((await swAgent("nobody", true)).status).toBe(404);
		expect((await api("PUT", "/subagents", { enabled: "yes" })).status).toBe(400);
		expect((await api("PUT", "/subagents", {})).status).toBe(400);
		expect((await api("PUT", "/subagents", { enabled: true, agents: [] })).status).toBe(400);
		expect((await api("PUT", "/subagents/explore", { enabled: 1 })).status).toBe(400);
		await reset();
	});

	test("a project file for the cwd is listed and wins over the global one of the same name", async () => {
		await reset();
		agentFile("explore", { description: "global" });
		mkdirSync(join(ws, ".agents", "subagents"), { recursive: true });
		writeFileSync(join(ws, ".agents", "subagents", "explore.md"), "---\ndescription: project\n---\n");
		try {
			expect((await list()).agents[0].description).toBe("global");
			const r = (await api("GET", `/subagents?cwd=${encodeURIComponent(ws)}`)).json;
			expect(r.agents).toHaveLength(1);
			expect(r.agents[0]).toMatchObject({ description: "project", scope: "project" });
		} finally {
			rmSync(join(ws, ".agents"), { recursive: true, force: true });
			await reset();
		}
	});
});

describe("settings change what delegate does", () => {
	test("the switch turns delegate off without removing the tool, and no model request is made", async () => {
		await reset();
		agentFile("explore");
		await sw(false);
		const result = await delegate(await newSession(), { task: "x" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("switched off");
		expect(helperRequest()).toBeUndefined();
		await sw(true);
		expect((await delegate(await newSession(), { task: "x" })).isError).not.toBe(true);
	});

	test("with no model set the helper runs on the calling session's model", async () => {
		await reset();
		agentFile("explore");
		const id = (await api("POST", "/sessions", { cwd: ws, approval: "auto", provider: "echo", model: LIGHT.id })).json.id as string;
		const result = await delegate(id, { task: "hi" });
		expect(result.details.model).toBe(LIGHT.id);
		expect(helperRequest()!.body.model).toBe(LIGHT.id);
	});

	test("a configured model is used whatever model the session has; edits to the file apply to the next call", async () => {
		await reset();
		agentFile("explore", { model: `echo/${LIGHT.id}` });
		const result = await delegate(await newSession(), { task: "hi" });
		expect(result.details).toMatchObject({ provider: "echo", model: LIGHT.id });
		expect(helperRequest()!.body.model).toBe(LIGHT.id);
		agentFile("explore", { model: `echo/${THINK.id}` });
		expect((await delegate(await newSession(), { task: "hi" })).details.model).toBe(THINK.id);
	});

	test("the model and its reasoning strength travel together; unset strength means minimal", async () => {
		await reset();
		const seen = async (thinking?: string) => {
			agentFile("explore", { model: `echo/${THINK.id}`, ...(thinking ? { thinking } : {}) });
			const r = await delegate(await newSession(), { task: "hi" });
			expect(r.isError).not.toBe(true);
			return helperRequest()!.body.reasoning_effort;
		};
		expect(await seen("high")).toBe("high");
		expect(await seen("low")).toBe("low");
		expect(await seen()).toBe("minimal");
		expect(THINKING_LEVELS).toContain("high");
	});

	test("a model without reasoning is simply called without it", async () => {
		await reset();
		agentFile("explore", { model: `echo/${LIGHT.id}`, thinking: "high" });
		expect((await delegate(await newSession(), { task: "hi" })).isError).not.toBe(true);
	});

	test("a model that does not exist falls back to the session's model instead of failing", () => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		const known = (_p: string, m: string) => (m === "here" ? ({} as any) : undefined);
		const settings = new SubAgentSettings(db, { models: { getModel: known } } as any);
		const session = { provider: "echo", model: "session" };
		expect(settings.resolve({ model: { provider: "echo", model: "gone", thinkingLevel: "high" } as any }, session)).toEqual({ provider: "echo", model: "session", thinkingLevel: "minimal", custom: false });
		expect(settings.resolve({ model: { provider: "echo", model: "here" } }, session)).toEqual({ provider: "echo", model: "here", thinkingLevel: "minimal", custom: true });
	});
});

describe("settings saved by earlier versions", () => {
	const store = (value: object) => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		db.query("INSERT INTO settings (key, data) VALUES ('subagents', $d)").run({ d: JSON.stringify(value) });
		return new SubAgentSettings(db, {} as any).get();
	};
	test("only the master switch survives; helpers that lived in the database are ignored", () => {
		expect(store({ enabled: false, agents: [{ name: "explore" }] })).toEqual({ enabled: false, disabled: [] });
		expect(store({ enabled: true, model: null })).toEqual({ enabled: true, disabled: [] });
		expect(store({ nonsense: 1 })).toEqual({ enabled: true, disabled: [] });
	});
});

describe("several helpers", () => {
	const two = () => {
		agentFile("explore", { model: `echo/${LIGHT.id}` }, "Be brief.");
		agentFile("deep", { description: "Reads slowly and carefully", model: `echo/${THINK.id}`, thinking: "high", tools: ["read"], maxTurns: 3 });
		agentFile("off", { description: "Disabled one", enabled: false });
	};

	test("the tool description lists the enabled helpers by name; a disabled one is not offered", async () => {
		await reset();
		two();
		await delegate(await newSession(), { task: "hi" });
		const main = upstream.requests.find((r) => !JSON.stringify(r.body?.messages?.[0]).includes("read-only research assistant"))!;
		const desc = main.body.tools.find((t: any) => t.function.name === "delegate").function.description as string;
		expect(desc).toContain("- explore:");
		expect(desc).toContain("- deep: Reads slowly and carefully");
		expect(desc).not.toContain("Disabled one");
	});

	test("switching a helper off in settings removes it from the tool description", async () => {
		await reset();
		two();
		await swAgent("deep", false);
		await delegate(await newSession(), { task: "hi" });
		const main = upstream.requests.find((r) => !JSON.stringify(r.body?.messages?.[0]).includes("read-only research assistant"))!;
		expect(main.body.tools.find((t: any) => t.function.name === "delegate").function.description).not.toContain("- deep:");
		await swAgent("deep", true);
	});

	test("`agent` picks the helper: its model, strength, tools and extra prompt are the ones used", async () => {
		await reset();
		two();
		const deep = await delegate(await newSession(), { task: "hi", agent: "deep" });
		expect(deep.isError).not.toBe(true);
		expect(deep.details).toMatchObject({ agent: "deep", model: THINK.id });
		const req = helperRequest()!;
		expect(req.body.model).toBe(THINK.id);
		expect(req.body.reasoning_effort).toBe("high");
		expect(req.body.tools.map((t: any) => t.function.name)).toEqual(["read"]);

		const explore = await delegate(await newSession(), { task: "hi", agent: "explore" });
		expect(explore.details).toMatchObject({ agent: "explore", model: LIGHT.id });
		const sys = JSON.stringify(helperRequest()!.body.messages[0]);
		expect(sys).toContain("read-only research assistant");
		expect(sys).toContain("Be brief.");
	});

	test("without `agent` the first enabled helper runs", async () => {
		await reset();
		two();
		await swAgent("deep", true);
		await swAgent("explore", false);
		const r = await delegate(await newSession(), { task: "hi" });
		expect(r.details.agent).toBe("deep");
		await swAgent("explore", true);
	});

	test("an unknown or disabled name is a tool error that names the helpers that exist; nothing is called", async () => {
		await reset();
		two();
		for (const agent of ["nope", "off"]) {
			const r = await delegate(await newSession(), { task: "hi", agent });
			expect(r.isError).toBe(true);
			expect(JSON.stringify(r.content)).toContain("available: deep, explore");
			expect(helperRequest()).toBeUndefined();
		}
	});

	test("with every helper disabled, delegate says so", async () => {
		await reset();
		agentFile("explore", { enabled: false });
		const r = await delegate(await newSession(), { task: "hi" });
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.content)).toContain("no sub-agent is enabled");
	});

	test("the step limit is per helper", async () => {
		await reset();
		two();
		const r = await delegate(await newSession(), { task: `!read ${JSON.stringify({ path: "a.txt" })}`, agent: "deep" });
		expect(r.details.turns).toBeLessThanOrEqual(3);
		unlinkSync(join(AGENTS(), "deep.md"));
		await reset();
	});
});
