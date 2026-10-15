import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { defaultAgent, DEFAULT_SUBAGENT_SETTINGS, SubAgentSettings } from "../src/subagent-settings.ts";
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
	app = await buildApp(cfg, { strictResponses: true });
	expect((await api("PUT", "/configuration/providers/echo", { ...echoProviderBody(upstream.baseUrl), models: [ECHO_MODEL, LIGHT, THINK] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

const SEEDED = () => ({ enabled: true, agents: [defaultAgent()] });
const one = (model: unknown, extra: object = {}) => ({ enabled: true, agents: [{ ...defaultAgent(), model, ...extra }] });
const current = async () => (await api("GET", "/subagents")).json.settings;
const currentModel = async () => (await current()).agents[0].model;
const save = (settings: unknown) => api("PUT", "/subagents", { settings });
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

describe("sub-agent settings API", () => {
	test("needs the token", async () => {
		expect((await api("GET", "/subagents", undefined, false)).status).toBe(401);
		expect((await api("PUT", "/subagents", { settings: DEFAULT_SUBAGENT_SETTINGS() }, false)).status).toBe(401);
	});

	test("a fresh server has delegate on but no helper, and writing tools can be offered to a helper", async () => {
		const r = (await api("GET", "/subagents")).json;
		expect(r.settings).toEqual({ enabled: true, agents: [] });
		expect(r.toolChoices).toEqual(["read", "grep", "ls", "write", "edit", "bash"]);
		expect(r.defaults).toEqual(r.settings);
	});

	test("save a model with its reasoning strength, read it back, announce the change, clear it with null", async () => {
		const pick = { provider: "echo", model: THINK.id, thinkingLevel: "high" };
		const put = await save(one(pick));
		expect(put.status).toBe(200);
		expect(put.json.settings.agents[0].model).toEqual(pick);
		expect(await currentModel()).toEqual(pick);
		const ev = app.bus.history({ after: 0, limit: 500 }).filter((e) => e.type === "configuration_updated" && (e.data as any).scope === "subagents");
		expect(ev.length).toBe(1);
		expect((await save(one({ provider: "echo", model: LIGHT.id }))).json.settings.agents[0].model).toEqual({ provider: "echo", model: LIGHT.id });
		expect((await save(DEFAULT_SUBAGENT_SETTINGS())).json.settings).toEqual({ enabled: true, agents: [] });
	});

	test("bad input is refused and changes nothing", async () => {
		const good = one({ provider: "echo", model: LIGHT.id });
		await save(good);
		const bad: unknown[] = [
			one({ provider: "echo", model: "missing" }),
			one({ provider: "echo", model: LIGHT.id, thinkingLevel: "off" }), // reasoning cannot be switched off
			one({ provider: "echo", model: LIGHT.id, thinkingLevel: "extreme" }),
			one({ provider: "echo" }),
			one({ provider: "echo", model: LIGHT.id, extra: 1 }),
			one(null, { tools: ["delegate"] }), // a helper cannot start another helper
			one(null, { tools: ["ask_user"] }),
			one(null, { tools: [] }),
			one(null, { tools: ["read", "read"] }),
			one(null, { name: "Bad Name" }),
			one(null, { name: "" }),
			one(null, { description: "" }),
			one(null, { maxTurns: 1 }),
			one(null, { maxTurns: 31 }),
			one(null, { prompt: "x".repeat(2001) }),
			{ enabled: true, agents: [defaultAgent(), defaultAgent()] }, // duplicate names
			{ enabled: true, agents: Array.from({ length: 11 }, (_, i) => ({ ...defaultAgent(), name: `a${i}` })) },
			{ enabled: true },
			{ agents: [] },
			{ enabled: "yes", agents: [] },
			{ enabled: true, agents: [], model: null }, // the one-helper shape is gone
		];
		for (const settings of bad) expect((await save(settings)).status).toBe(400);
		expect(await current()).toEqual(good);
		await save(SEEDED());
	});
});

describe("settings change what delegate does", () => {
	test("the switch turns delegate off without removing the tool, and no model request is made", async () => {
		await save({ ...SEEDED(), enabled: false });
		const id = await newSession();
		const result = await delegate(id, { task: "x" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("switched off");
		expect(helperRequest()).toBeUndefined();
		await save(SEEDED());
		expect((await delegate(await newSession(), { task: "x" })).isError).not.toBe(true);
	});

	test("with no model set the helper runs on the calling session's model", async () => {
		await save(SEEDED());
		const id = (await api("POST", "/sessions", { cwd: ws, approval: "auto", provider: "echo", model: LIGHT.id })).json.id as string;
		const result = await delegate(id, { task: "hi" });
		expect(result.details.model).toBe(LIGHT.id);
		expect(helperRequest()!.body.model).toBe(LIGHT.id);
	});

	test("a configured model is used whatever model the session has", async () => {
		await save(one({ provider: "echo", model: LIGHT.id }));
		const result = await delegate(await newSession(), { task: "hi" });
		expect(result.details).toMatchObject({ provider: "echo", model: LIGHT.id });
		expect(helperRequest()!.body.model).toBe(LIGHT.id);
		await save(SEEDED());
	});

	test("the model and its reasoning strength travel together; unset strength means minimal", async () => {
		const seen = async (thinkingLevel?: string) => {
			expect((await save(one({ provider: "echo", model: THINK.id, ...(thinkingLevel ? { thinkingLevel } : {}) }))).status).toBe(200);
			const r = await delegate(await newSession(), { task: "hi" });
			expect(r.isError).not.toBe(true);
			return helperRequest()!.body.reasoning_effort;
		};
		expect(await seen("high")).toBe("high");
		expect(await seen("low")).toBe("low");
		expect(await seen()).toBe("minimal");
		await save(SEEDED());
	});

	test("a model without reasoning is simply called without it", async () => {
		await save(one({ provider: "echo", model: LIGHT.id, thinkingLevel: "high" }));
		const r = await delegate(await newSession(), { task: "hi" });
		expect(r.isError).not.toBe(true);
		await save(SEEDED());
	});

	test("a model that was deleted after saving falls back to the session's model instead of failing", async () => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		db.query("INSERT INTO settings (key, data) VALUES ('subagents', $d)").run({ d: JSON.stringify({ enabled: true, agents: [{ ...defaultAgent(), model: { provider: "echo", model: "gone", thinkingLevel: "high" } }] }) });
		const known = (_p: string, m: string) => (m === "here" ? ({} as any) : undefined);
		const settings = new SubAgentSettings(db, { models: { getModel: known } } as any);
		const session = { provider: "echo", model: "session" };
		expect(settings.resolve(settings.get().agents[0]!, session)).toEqual({ provider: "echo", model: "session", thinkingLevel: "minimal", custom: false });
		const saved = settings.set({ enabled: true, agents: [defaultAgent({ provider: "echo", model: "here" })] });
		expect(settings.resolve(saved.agents[0]!, session)).toEqual({ provider: "echo", model: "here", thinkingLevel: "minimal", custom: true });
	});
});

describe("settings saved by earlier versions", () => {
	const store = (value: object, roles?: object) => {
		const db = new Database(":memory:", { strict: true });
		db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		db.query("INSERT INTO settings (key, data) VALUES ('subagents', $d)").run({ d: JSON.stringify(value) });
		if (roles) db.query("INSERT INTO settings (key, data) VALUES ('model_roles', $d)").run({ d: JSON.stringify(roles) });
		return new SubAgentSettings(db, {} as any).get() as any;
	};
	const old = (extra: object = {}) => ({ name: "explore", description: "d", enabled: true, role: null, model: null, thinkingLevel: null, tools: ["read"], maxTurns: 7, maxReportChars: 1000, prompt: "p", ...extra });
	const multi = (agents: object[]) => ({ enabled: true, allowModelChoice: true, allowedRoles: ["light"], agents });

	test("the one-helper shape becomes a single 'explore' helper with that model", () => {
		const model = { provider: "p", model: "m", thinkingLevel: "low" };
		expect(store({ enabled: true, model })).toEqual({ enabled: true, agents: [defaultAgent(model as any)] });
		expect(store({ enabled: false, model: null })).toEqual({ enabled: false, agents: [defaultAgent()] });
	});
	test("the several-helpers shape keeps every helper, with its tools, steps and prompt", () => {
		const r = store(multi([old({ model: { provider: "p", model: "m" }, thinkingLevel: "low" }), old({ name: "second", enabled: false })]));
		expect(r.agents).toEqual([
			{ name: "explore", description: "d", enabled: true, model: { provider: "p", model: "m", thinkingLevel: "low" }, tools: ["read"], maxTurns: 7, prompt: "p" },
			{ name: "second", description: "d", enabled: false, model: null, tools: ["read"], maxTurns: 7, prompt: "p" },
		]);
	});
	test("a role is replaced by the model it pointed at; an unmapped role becomes 'the session's model'", () => {
		expect(store(multi([old({ role: "explore" })]), { explore: { provider: "p", model: "light" } }).agents[0].model).toEqual({ provider: "p", model: "light" });
		expect(store(multi([old({ role: "explore" })])).agents[0].model).toBeNull();
	});
	test("the master switch carries over", () => {
		expect(store({ ...multi([old()]), enabled: false }).enabled).toBe(false);
	});
});

describe("several helpers", () => {
	const two = () => ({
		enabled: true,
		agents: [
			{ ...defaultAgent({ provider: "echo", model: LIGHT.id }), name: "explore", prompt: "Be brief." },
			{ ...defaultAgent({ provider: "echo", model: THINK.id, thinkingLevel: "high" } as any), name: "deep", description: "Reads slowly and carefully", tools: ["read"], maxTurns: 3 },
			{ ...defaultAgent(), name: "off", description: "Disabled one", enabled: false },
		],
	});

	test("the tool description lists the enabled helpers by name; a disabled one is not offered", async () => {
		expect((await save(two())).status).toBe(200);
		const id = await newSession();
		await delegate(id, { task: "hi" });
		const main = upstream.requests.find((r) => !JSON.stringify(r.body?.messages?.[0]).includes("read-only research assistant"))!;
		const desc = main.body.tools.find((t: any) => t.function.name === "delegate").function.description as string;
		expect(desc).toContain("- explore:");
		expect(desc).toContain("- deep: Reads slowly and carefully");
		expect(desc).not.toContain("Disabled one");
	});

	test("`agent` picks the helper: its model, strength, tools and extra prompt are the ones used", async () => {
		await save(two());
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
		const s = two();
		s.agents[0]!.enabled = false;
		await save(s);
		const r = await delegate(await newSession(), { task: "hi" });
		expect(r.details.agent).toBe("deep");
	});

	test("an unknown or disabled name is a tool error that names the helpers that exist; nothing is called", async () => {
		await save(two());
		for (const agent of ["nope", "off"]) {
			const r = await delegate(await newSession(), { task: "hi", agent });
			expect(r.isError).toBe(true);
			expect(JSON.stringify(r.content)).toContain("available: explore, deep");
			expect(helperRequest()).toBeUndefined();
		}
	});

	test("with every helper disabled, delegate says so", async () => {
		await save({ enabled: true, agents: [{ ...defaultAgent(), enabled: false }] });
		const r = await delegate(await newSession(), { task: "hi" });
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.content)).toContain("no sub-agent is enabled");
		await save(SEEDED());
	});

	test("the step limit is per helper", async () => {
		const s = two();
		s.agents[1]!.maxTurns = 2;
		await save(s);
		const r = await delegate(await newSession(), { task: `!read ${JSON.stringify({ path: "a.txt" })}`, agent: "deep" });
		expect(r.details.turns).toBeLessThanOrEqual(2);
		await save(SEEDED());
	});
});
