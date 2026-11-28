import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { codenamePrefixOf } from "../src/member-names.ts";
import {
	DEFAULT_SYSTEM_MODEL_TASKS,
	describeRequest,
	describeSystemPrompt,
	groupNameRequest,
	parseDescription,
	parseGroupName,
	sanitizeSessionName,
	uniqueSessionName,
} from "../src/system-model.ts";
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
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
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

describe("parseDescription and session names", () => {
	test("reads the JSON out of prose or a code fence and tidies it", () => {
		expect(parseDescription('```json\n{"title": "Fix login bug.", "purpose": "  fixes the\\nlogin flow "}\n```')).toEqual({ title: "Fix login bug", purpose: "fixes the login flow" });
		expect(parseDescription('{"title": "Auth", "purpose": "auth work", "name": "@auth fix!"}')).toEqual({ title: "Auth", purpose: "auth work", name: "auth-fix" });
		expect(parseDescription('{"name": "로그인-수정"}')).toEqual({ title: "", purpose: "", name: "로그인-수정" });
		expect(parseDescription('{"name": "A1"}')).toBeNull();
		expect(parseDescription("no json here")).toBeNull();
		expect(parseDescription('{"title": "", "purpose": ""}')).toBeNull();
		expect(parseDescription('{"title": 3}')).toBeNull();
	});
	test("sanitizeSessionName normalizes handles and rejects invalid or codename-like values", () => {
		expect(sanitizeSessionName("  @Auth / Fix!  ")).toBe("Auth-Fix");
		expect(sanitizeSessionName("`로그인 수정`")).toBe("로그인-수정");
		expect(sanitizeSessionName("A1")).toBe("");
		expect(sanitizeSessionName("b12")).toBe("");
		expect(sanitizeSessionName("---")).toBe("");
		expect(sanitizeSessionName(null)).toBe("");
		expect(sanitizeSessionName("a".repeat(40)).length).toBe(20);
	});
	test("uniqueSessionName avoids case-insensitive collisions with numbered suffixes", () => {
		const taken = new Set(["auth-fix", "auth-fix-2"]);
		expect(uniqueSessionName("Auth-Fix", taken)).toBe("Auth-Fix-3");
		expect(uniqueSessionName("fresh", taken)).toBe("fresh");
		expect(uniqueSessionName("A1", taken)).toBe("");
	});
	test("describeSystemPrompt includes only the requested fields", () => {
		const nameOnly = describeSystemPrompt({ name: true });
		expect(nameOnly).toContain('"name": "..."');
		expect(nameOnly).not.toContain('"title"');
		expect(nameOnly).not.toContain('"purpose"');
		const titleAndPurpose = describeSystemPrompt({ title: true, purpose: true });
		expect(titleAndPurpose).toContain('"title": "..."');
		expect(titleAndPurpose).toContain('"purpose": "..."');
		expect(titleAndPurpose).not.toContain('"name"');
	});
	test("the request carries the first message and, when different, the latest", () => {
		const r = describeRequest("/w", "first", "later");
		expect(r).toContain("first");
		expect(r).toContain("Latest user message:\nlater");
		expect(describeRequest("/w", "same", "same")).not.toContain("Latest");
	});
});

describe("system model", () => {
	test("is off by default with default task toggles, saves a model, rejects unknown ones", async () => {
		const expected = { model: null, tasks: DEFAULT_SYSTEM_MODEL_TASKS() };
		expect((await api("GET", "/system-model")).json).toEqual({ settings: expected, defaults: expected });
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
		expect(codenamePrefixOf(s.name)).not.toBeNull();
		expect(upstream.requests.map((r) => r.body.model)).toEqual([ECHO_MODEL.id]);
	});

	test("on: the system model writes title and role in the background, with its own model", async () => {
		// the echo upstream answers "Echo: <input>", so a JSON object in the input comes back as the reply
		expect((await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id } })).json.settings.model).toEqual({ provider: "echo", model: LIGHT.id });
		await settle(); // the backfill for the earlier session
		const id = await newSession();
		const before = (await api("GET", `/sessions/${id}`)).json;
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Login fix", "purpose": "fixes the login page", "name": "login-fix"}' });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Login fix");
		expect(s.purpose).toBe("fixes the login page");
		// sessionName defaults to false, so @name stays its codename
		expect(s.name).toBe(before.name);
		const light = upstream.requests.filter((r) => r.body.model === LIGHT.id);
		expect(light).toHaveLength(1);
		expect(light[0]!.body.messages[0].content).toContain("label a coding-agent session");
		expect(light[0]!.body.messages[0].content).not.toContain('"name"');

		// once written, the system model is not asked again
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

	test("a reply without JSON leaves the session as it is", async () => {
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: "plain words" });
		await settle();
		const s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("plain words");
		expect(s.purpose).toBe("");
	});

	test("task toggles independently control title, purpose, session @name, and partial updates preserve other flags", async () => {
		// Disable title & purpose, enable only sessionName
		const put1 = await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: false, sessionPurpose: false, sessionName: true, groupName: false },
		});
		expect(put1.status).toBe(200);
		expect(put1.json.settings.tasks).toEqual({ sessionTitle: false, sessionPurpose: false, sessionName: true, groupName: false });
		await settle();

		// Omitting tasks preserves existing flags
		const put2 = await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id } });
		expect(put2.json.settings.tasks).toEqual({ sessionTitle: false, sessionPurpose: false, sessionName: true, groupName: false });
		await settle();

		const id1 = await newSession();
		const payload = '{"title": "Ignored Title", "purpose": "Ignored Purpose", "name": "auth-flow"}';
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id1}/messages`, { text: payload });
		await settle();
		const s1 = (await api("GET", `/sessions/${id1}`)).json;
		expect(s1.name).toBe("auth-flow");
		expect(s1.title).toBe(payload.slice(0, 60));
		expect(s1.purpose).toBe("");
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(1);

		// Second message does not re-trigger the system model even with empty purpose
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id1}/messages`, { text: '{"name": "renamed-again"}' });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
		expect((await api("GET", `/sessions/${id1}`)).json.name).toBe("auth-flow");

		// Collision gets numbered suffix
		const id2 = await newSession();
		await api("POST", `/sessions/${id2}/messages`, { text: '{"name": "Auth-Flow"}' });
		await settle();
		expect((await api("GET", `/sessions/${id2}`)).json.name).toBe("Auth-Flow-2");

		// Forked child session (parentId set) keeps its lineage codename
		const forked = (await api("POST", `/sessions/${id1}/fork`, {})).json;
		const forkedName = forked.name as string;
		await api("POST", `/sessions/${forked.id}/messages`, { text: '{"name": "should-not-apply"}' });
		await settle();
		expect((await api("GET", `/sessions/${forked.id}`)).json.name).toBe(forkedName);

		// Session with only title enabled (purpose off, sessionName off) runs once and does not re-run on message 2
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: true, sessionPurpose: false, sessionName: false, groupName: false },
		});
		await settle();
		const id3 = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id3}/messages`, { text: '{"title": "Only Title", "purpose": "No Purpose", "name": "no-name"}' });
		await settle();
		const s3 = (await api("GET", `/sessions/${id3}`)).json;
		expect(s3.title).toBe("Only Title");
		expect(s3.purpose).toBe("");
		expect(codenamePrefixOf(s3.name)).not.toBeNull();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id3}/messages`, { text: '{"title": "Changed"}' });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);

		// Turning all session tasks off makes zero system-model calls
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: false, sessionPurpose: false, sessionName: false, groupName: false },
		});
		await settle();
		const id4 = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id4}/messages`, { text: '{"title": "Never", "purpose": "Never", "name": "never"}' });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);

		// Turning sessionName on later keeps existing sessions' codenames intact (does not retroactively break @A1 references)
		const id5 = await newSession();
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: true, sessionPurpose: true, sessionName: false, groupName: false },
		});
		await settle();
		await api("POST", `/sessions/${id5}/messages`, { text: '{"title": "Has Title", "purpose": "Has Purpose", "name": "backfill-handle"}' });
		await settle();
		const s5Before = (await api("GET", `/sessions/${id5}`)).json;
		expect(s5Before.title).toBe("Has Title");
		expect(s5Before.purpose).toBe("Has Purpose");
		expect(codenamePrefixOf(s5Before.name)).not.toBeNull();

		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: true, sessionPurpose: true, sessionName: true, groupName: false },
		});
		await settle();
		expect((await api("GET", `/sessions/${id5}`)).json.name).toBe(s5Before.name);

		// A brand-new session started after enabling sessionName gets a topic-based @name
		const id6 = await newSession();
		await api("POST", `/sessions/${id6}/messages`, { text: '{"title": "New Work", "purpose": "New role", "name": "fresh-handle"}' });
		await settle();
		const s6 = (await api("GET", `/sessions/${id6}`)).json;
		expect(s6.name).toBe("fresh-handle");
		expect(s6.title).toBe("New Work");
		expect(s6.purpose).toBe("New role");

		// Stored rows with unknown/future keys still preserve the saved model and known task flags
		const rawDb = new Database(join(dir, "db.sqlite"), { strict: true });
		try {
			rawDb.query("INSERT INTO settings (key, data) VALUES ('system_model', $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({
				data: JSON.stringify({ model: { provider: "echo", model: LIGHT.id }, tasks: { sessionName: true, futureFlag: true }, extra: 1 }),
			});
		} finally {
			rawDb.close();
		}
		const loaded = (await api("GET", "/system-model")).json.settings;
		expect(loaded.model).toEqual({ provider: "echo", model: LIGHT.id });
		expect(loaded.tasks).toEqual({ sessionTitle: true, sessionPurpose: true, sessionName: true, groupName: true });
	});

	test("groupName toggle controls automatic split-group naming", async () => {
		const a = await newSession();
		const b = await newSession();
		await api("PATCH", `/sessions/${a}`, { title: "Billing API" });
		await api("PATCH", `/sessions/${b}`, { title: "Billing UI" });
		const layoutOf = (x: string, y: string) => ({ type: "split", dir: "row", ratio: 0.5, a: { type: "pane", sessionId: x }, b: { type: "pane", sessionId: y } });

		// groupName off -> no system-model call and original name kept
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: false, sessionPurpose: false, sessionName: false, groupName: false },
		});
		upstream.requests.length = 0;
		const gOffRes = await api("POST", "/groups", { name: "Group 1", autoName: true, layout: layoutOf(a, b) });
		expect(gOffRes.status).toBe(201);
		const gOff = gOffRes.json;
		await new Promise((r) => setTimeout(r, 80));
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
		expect((await api("GET", "/groups")).json.groups.find((x: { id: string }) => x.id === gOff.id).name).toBe("Group 1");

		// groupName on -> system model is called to name the group
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { groupName: true },
		});
		upstream.requests.length = 0;
		const c = await newSession();
		const d = await newSession();
		const gOnRes = await api("POST", "/groups", { name: "Group 2", autoName: true, layout: layoutOf(c, d) });
		expect(gOnRes.status).toBe(201);
		const gOn = gOnRes.json;
		await new Promise((r) => setTimeout(r, 120));
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id).length).toBeGreaterThanOrEqual(1);
		const updated = (await api("GET", "/groups")).json.groups.find((x: { id: string }) => x.id === gOn.id);
		expect(updated.name).not.toBe("Group 2");
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
