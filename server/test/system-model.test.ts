import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { describeRequest, groupNameRequest, parseDescription, parseGroupName } from "../src/system-model.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
const LIGHT = { id: "echo-light", name: "Echo light", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false };
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
	dir = mkdtempSync(join(tmpdir(), "pipaya-sysmodel-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
	expect((await api("PUT", "/configuration/providers/echo", { ...echoProviderBody(upstream.baseUrl), models: [ECHO_MODEL, LIGHT] })).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

const newSession = async () => (await api("POST", "/sessions", { cwd: ws })).json.id as string;
const settle = async () => { await app.sessions.idle(); await app.sessions.idle(); };

describe("parseDescription", () => {
	test("reads the JSON out of prose or a code fence and tidies it", () => {
		expect(parseDescription('```json\n{"title": "Fix login bug.", "purpose": "  fixes the\\nlogin flow "}\n```')).toEqual({ title: "Fix login bug", purpose: "fixes the login flow" });
		expect(parseDescription("no json here")).toBeNull();
		expect(parseDescription('{"title": "", "purpose": ""}')).toBeNull();
		expect(parseDescription('{"title": 3}')).toBeNull();
	});
	test("the request carries the first message and, when different, the latest", () => {
		const r = describeRequest("/w", "first", "later");
		expect(r).toContain("first");
		expect(r).toContain("Latest user message:\nlater");
		expect(describeRequest("/w", "same", "same")).not.toContain("Latest");
	});
});

describe("system model", () => {
	test("is off by default, saves a model, rejects unknown ones", async () => {
		expect((await api("GET", "/system-model")).json).toEqual({ settings: { model: null }, defaults: { model: null } });
		expect((await api("PUT", "/system-model", { model: { provider: "echo", model: "nope" } })).status).toBe(400);
		expect((await api("PUT", "/system-model", {})).status).toBe(400);
	});

	test("off: the title is the first message cut short and no role is written", async () => {
		const id = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "hello there" });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("hello there");
		expect(s.purpose).toBe("");
		expect(upstream.requests.map((r) => r.body.model)).toEqual([ECHO_MODEL.id]);
	});

	test("on: the system model writes title and role in the background, with its own model", async () => {
		// the echo upstream answers "Echo: <input>", so a JSON object in the input comes back as the reply
		expect((await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id } })).json.settings.model).toEqual({ provider: "echo", model: LIGHT.id });
		await settle(); // the backfill for the earlier session
		const id = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Login fix", "purpose": "fixes the login page"}' });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Login fix");
		expect(s.purpose).toBe("fixes the login page");
		const light = upstream.requests.filter((r) => r.body.model === LIGHT.id);
		expect(light).toHaveLength(1);
		expect(light[0]!.body.messages[0].content).toContain("label a coding-agent session");

		// a role, once written, is not asked for again
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Other", "purpose": "other"}' });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
		expect((await api("GET", `/sessions/${id}`)).json.title).toBe("Login fix");
	});

	test("a title the user set is kept; only the role is filled in", async () => {
		const id = await newSession();
		await api("PATCH", `/sessions/${id}`, { title: "My name" });
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Model name", "purpose": "does things"}' });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("My name");
		expect(s.purpose).toBe("does things");
	});

	test("sessions that talked before the model was set get a role when it is set", async () => {
		await api("PUT", "/system-model", { model: null });
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Backfilled", "purpose": "was there before"}' });
		await settle();
		expect((await api("GET", `/sessions/${id}`)).json.purpose).toBe("");
		await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id } });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.purpose).toBe("was there before");
		expect(s.title).toBe("Backfilled");
	});

	test("mentioning a session tells the agent its role", async () => {
		const peer = await newSession();
		await api("POST", `/sessions/${peer}/messages`, { text: '{"title": "Docs", "purpose": "writes the docs"}' });
		await settle();
		const name = (await api("GET", `/sessions/${peer}`)).json.name as string;
		const id = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: `ask @${name} please` });
		await settle();
		const main = upstream.requests.find((r) => r.body.model === ECHO_MODEL.id)!;
		expect(JSON.stringify(main.body.messages)).toContain(`@${name} (writes the docs)`);
	});

	test("a reply without JSON leaves the session as it is", async () => {
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: "plain words" });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("plain words");
		expect(s.purpose).toBe("");
	});
});

describe("group names", () => {
	test("parseGroupName takes the first line and strips quotes and markup", () => {
		expect(parseGroupName('"Billing API"\nbecause...')).toBe("Billing API");
		expect(parseGroupName("**Name: Docs sync.**")).toBe("Docs sync");
		expect(parseGroupName("   \n")).toBeNull();
	});
	test("groupNameRequest lists each session's folder, title and role", () => {
		const text = groupNameRequest([{ cwd: "/w/pipaya/", title: "Fix login", purpose: "auth work" }, { cwd: "/w/wiki", title: "Docs", purpose: "" }]);
		expect(text).toContain("1. folder: pipaya; title: Fix login; role: auth work");
		expect(text).toContain("2. folder: wiki; title: Docs\n");
	});
});
