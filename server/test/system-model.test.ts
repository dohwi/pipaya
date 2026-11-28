import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { codenamePrefixOf } from "../src/member-names.ts";
import { SessionDescriber } from "../src/session-describer.ts";
import { SessionSuggester } from "../src/session-suggestions.ts";
import { SessionStore } from "../src/store.ts";
import {
	DEFAULT_REFRESH_EVERY,
	DEFAULT_SYSTEM_MODEL_TASKS,
	describeRefreshRequest,
	describeRefreshSystemPrompt,
	describeRequest,
	describeSystemPrompt,
	followUpRequest,
	groupNameRequest,
	parseDescription,
	parseFollowUpSuggestions,
	parseGroupName,
	parseRefreshDescription,
	sanitizeSessionName,
	SystemModelSettings,
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
	test("refresh prompt, request, and parser handle null keep-as-is and multi-JSON replies", () => {
		const titleOnly = describeRefreshSystemPrompt({ title: true });
		expect(titleOnly).toContain('"title": "..." | null');
		expect(titleOnly).not.toContain('"purpose"');
		const req = describeRefreshRequest({
			cwd: "/w",
			currentTitle: "Old title",
			currentPurpose: "Old purpose",
			first: "start work",
			recent: ["step 2", "pivot to billing"],
		});
		expect(req).toContain("Current title: Old title");
		expect(req).toContain("Current purpose: Old purpose");
		expect(req).toContain("First user message:\nstart work");
		expect(req).toContain("1. step 2\n2. pivot to billing");
		expect(describeRefreshRequest({ cwd: "/w", first: "only", recent: ["only"] })).not.toContain("Recent user messages");

		expect(parseRefreshDescription('{"title": null, "purpose": null}')).toEqual({ title: null, purpose: null });
		expect(parseRefreshDescription('```json\n{"title": "Billing webhook.", "purpose": null}\n```')).toEqual({
			title: "Billing webhook",
			purpose: null,
		});
		// Multiple JSON blocks (e.g. quoted earlier JSON or echo upstream) pick the last valid object
		expect(
			parseRefreshDescription('Earlier "quote {"title": "Old", "purpose": "old"}\nLatest: {"title": "New", "purpose": null}'),
		).toEqual({ title: "New", purpose: null });
		// Unbalanced opening brace in prose before the real JSON still parses
		expect(parseRefreshDescription('Note { see below: {"title": "Recovered", "purpose": null}')).toEqual({
			title: "Recovered",
			purpose: null,
		});
		expect(parseRefreshDescription('{"title": "   "}', { title: true })).toEqual({ title: null });
		expect(parseRefreshDescription("not json")).toBeNull();
		expect(parseRefreshDescription('{"other": "value"}')).toBeNull();
		expect(parseRefreshDescription('{"title": 123}', { title: true })).toBeNull();
	});
});

describe("system model", () => {
	test("is off by default with default task toggles, saves a model, rejects unknown ones", async () => {
		const expected = { model: null, tasks: DEFAULT_SYSTEM_MODEL_TASKS(), refreshEvery: DEFAULT_REFRESH_EVERY };
		expect((await api("GET", "/system-model")).json).toEqual({ settings: expected, defaults: expected });
		expect((await api("PUT", "/system-model", { model: { provider: "echo", model: "nope" } })).status).toBe(400);
		expect((await api("PUT", "/system-model", { model: null, refreshEvery: -1 })).status).toBe(400);
		expect((await api("PUT", "/system-model", { model: null, refreshEvery: 101 })).status).toBe(400);
		expect((await api("PUT", "/system-model", { model: null, refreshEvery: 2.5 })).status).toBe(400);
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
		expect(put1.json.settings.tasks).toEqual({ sessionTitle: false, sessionPurpose: false, sessionName: true, groupName: false, followUpSuggestions: false });
		await settle();

		// Omitting tasks preserves existing flags
		const put2 = await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id } });
		expect(put2.json.settings.tasks).toEqual({ sessionTitle: false, sessionPurpose: false, sessionName: true, groupName: false, followUpSuggestions: false });
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
		expect(loaded.tasks).toEqual({ sessionTitle: true, sessionPurpose: true, sessionName: true, groupName: true, followUpSuggestions: false });
		expect(loaded.refreshEvery).toBe(0);

		// Invalid refreshEvery values in DB (negative, > max, float) fall back to 0 without losing model/tasks
		for (const badRefresh of [-5, 101, 2.5, "5"]) {
			const rawDb2 = new Database(join(dir, "db.sqlite"), { strict: true });
			try {
				rawDb2.query("INSERT INTO settings (key, data) VALUES ('system_model', $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({
					data: JSON.stringify({ model: { provider: "echo", model: LIGHT.id }, tasks: { sessionTitle: true }, refreshEvery: badRefresh }),
				});
			} finally {
				rawDb2.close();
			}
			expect((await api("GET", "/system-model")).json.settings.refreshEvery).toBe(0);
		}
	});

	test("periodic refresh updates auto-written title/purpose every N user messages while protecting manual edits and @name", async () => {
		// Configure refreshEvery = 3 with title, purpose, and sessionName enabled
		const put = await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: true, sessionPurpose: true, sessionName: true, groupName: false },
			refreshEvery: 3,
		});
		expect(put.status).toBe(200);
		expect(put.json.settings.refreshEvery).toBe(3);
		await settle();

		// Omitting refreshEvery preserves the saved interval
		const keep = await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id } });
		expect(keep.json.settings.refreshEvery).toBe(3);
		await settle();

		const id = await newSession();
		upstream.requests.length = 0;
		// Message 1: initial describe sets title, purpose, and @name
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Auth bug", "purpose": "fix login flow", "name": "auth-bug"}' });
		await settle();
		let s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Auth bug");
		expect(s.purpose).toBe("fix login flow");
		expect(s.name).toBe("auth-bug");
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(1);

		// Messages 2 and 3: below refreshEvery=3 -> zero system-model calls
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "checking logs" });
		await settle();
		await api("POST", `/sessions/${id}/messages`, { text: "still debugging auth" });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);

		// Message 4 (3 messages after initial): triggers refresh; updates title & purpose, keeps @name stable
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Billing refactor", "purpose": "migrate billing webhooks", "name": "billing-new"}' });
		await settle();
		s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Billing refactor");
		expect(s.purpose).toBe("migrate billing webhooks");
		expect(s.name).toBe("auth-bug"); // @name never mutates on periodic refresh
		const refreshCalls = upstream.requests.filter((r) => r.body.model === LIGHT.id);
		expect(refreshCalls).toHaveLength(1);
		expect(refreshCalls[0]!.body.messages[0].content).toContain("review a coding-agent session");
		expect(refreshCalls[0]!.body.messages[1].content).toContain("Current title: Auth bug");
		expect(refreshCalls[0]!.body.messages[1].content).toContain("Current purpose: fix login flow");

		// Messages 5 and 6: below next threshold -> zero system-model calls
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "adding webhook tests" });
		await settle();
		await api("POST", `/sessions/${id}/messages`, { text: "running test suite" });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);

		// Message 7: model returns null (no topic shift) -> keeps labels, emits no session_updated, advances counter
		const updatedEvents: unknown[] = [];
		const unsub = app.bus.subscribe((e) => {
			if (e.sessionId === id && e.type === "session_updated") updatedEvents.push(e);
		});
		try {
			upstream.requests.length = 0;
			await api("POST", `/sessions/${id}/messages`, { text: '{"title": null, "purpose": null}' });
			await settle();
		} finally {
			unsub();
		}
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(1);
		expect(updatedEvents).toHaveLength(0);
		s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Billing refactor");
		expect(s.purpose).toBe("migrate billing webhooks");

		// Message 8: counter advanced on null response -> zero calls
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "another follow-up" });
		await settle();
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);

		// No-op PATCH sending the same title/purpose does not lock them out of periodic refresh
		await api("PATCH", `/sessions/${id}`, { title: "Billing refactor", purpose: "migrate billing webhooks" });

		// Manual title rename locks title while purpose remains eligible for refresh (even across memory clear)
		await api("PATCH", `/sessions/${id}`, { title: "Pinned manually" });
		await api("POST", `/sessions/${id}/messages`, { text: "step 9" });
		await settle();
		upstream.requests.length = 0;
		// Message 10 (3 messages after #7): only purpose is requested and updated; manual title stays untouched
		await api("POST", `/sessions/${id}/messages`, { text: '{"title": "Should not overwrite", "purpose": "docs and release prep"}' });
		await settle();
		s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Pinned manually");
		expect(s.purpose).toBe("docs and release prep");
		const purposeOnlyCalls = upstream.requests.filter((r) => r.body.model === LIGHT.id);
		expect(purposeOnlyCalls).toHaveLength(1);
		expect(purposeOnlyCalls[0]!.body.messages[0].content).not.toContain('"title"');
		expect(purposeOnlyCalls[0]!.body.messages[0].content).toContain('"purpose"');

		// Manually editing purpose too means neither field is auto-managed -> zero refresh calls
		await api("PATCH", `/sessions/${id}`, { purpose: "Pinned role" });
		upstream.requests.length = 0;
		for (const msg of ["m11", "m12", '{"title": "Nope", "purpose": "Nope"}']) {
			await api("POST", `/sessions/${id}/messages`, { text: msg });
			await settle();
		}
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
		s = (await api("GET", `/sessions/${id}`)).json;
		expect(s.title).toBe("Pinned manually");
		expect(s.purpose).toBe("Pinned role");

		// Clearing purpose allows regeneration and re-enables auto-refresh for purpose
		await api("PATCH", `/sessions/${id}`, { purpose: "" });
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: '{"purpose": "regenerated role"}' });
		await settle();
		expect((await api("GET", `/sessions/${id}`)).json.purpose).toBe("regenerated role");
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(1);

		// Setting refreshEvery back to 0 (falsy) turns periodic refresh off
		const off = await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id }, refreshEvery: 0 });
		expect(off.json.settings.refreshEvery).toBe(0);
		await settle();
		upstream.requests.length = 0;
		for (const msg of ["off1", "off2", '{"purpose": "should not refresh"}']) {
			await api("POST", `/sessions/${id}/messages`, { text: msg });
			await settle();
		}
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
		expect((await api("GET", `/sessions/${id}`)).json.purpose).toBe("regenerated role");
	});

	test("periodic refresh respects task toggles and keeps explicit creation titles untouched", async () => {
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: true, sessionPurpose: false, sessionName: false, groupName: false },
			refreshEvery: 2,
		});
		await settle();

		// Session created with explicit title -> never overwritten initially or on refresh
		const customId = (await api("POST", "/sessions", { cwd: ws, title: "Explicit Session" })).json.id as string;
		upstream.requests.length = 0;
		for (const msg of ['{"title": "Nope 1"}', "msg 2", '{"title": "Nope 2"}']) {
			await api("POST", `/sessions/${customId}/messages`, { text: msg });
			await settle();
		}
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
		expect((await api("GET", `/sessions/${customId}`)).json.title).toBe("Explicit Session");

		// Session with only sessionTitle enabled refreshes only title (never writes purpose)
		const titleOnlyId = await newSession();
		await api("POST", `/sessions/${titleOnlyId}/messages`, { text: '{"title": "Start topic", "purpose": "ignored"}' });
		await settle();
		expect((await api("GET", `/sessions/${titleOnlyId}`)).json.title).toBe("Start topic");
		expect((await api("GET", `/sessions/${titleOnlyId}`)).json.purpose).toBe("");
		await api("POST", `/sessions/${titleOnlyId}/messages`, { text: "second message" });
		await settle();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${titleOnlyId}/messages`, { text: '{"title": "Updated topic", "purpose": "still ignored"}' });
		await settle();
		const s = (await api("GET", `/sessions/${titleOnlyId}`)).json;
		expect(s.title).toBe("Updated topic");
		expect(s.purpose).toBe("");
		expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(1);

		// Reset refreshEvery to 0 so subsequent tests start clean
		await api("PUT", "/system-model", { model: { provider: "echo", model: LIGHT.id }, refreshEvery: 0 });
		await settle();
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
	test("periodic refresh handles in-flight manual rename, mid-flight delete, and count rewind safely", async () => {
		const unitDir = mkdtempSync(join(tmpdir(), "pipaya-describer-unit-"));
		const db = openDb(join(unitDir, "db.sqlite"));
		try {
			const store = new SessionStore(db);
			const model = { provider: "mock", id: "light", name: "Light", contextWindow: 8192, maxTokens: 1024, reasoning: false, vision: false };
			let resolveCall!: (replyText: string) => void;
			let markStarted!: () => void;
			let callStarted = new Promise<void>((r) => {
				markStarted = r;
			});
			let callCount = 0;
			const registry = {
				models: {
					getModel: (p: string, id: string) => (p === "mock" && id === "light" ? model : undefined),
					checkAuth: async () => true,
					completeSimple: () => {
						callCount++;
						markStarted();
						return new Promise((resolve) => {
							resolveCall = (text: string) =>
								resolve({
									role: "assistant",
									content: [{ type: "text", text }],
									stopReason: "stop",
								});
						});
					},
				},
			} as any;
			const nextCall = () => {
				callStarted = new Promise<void>((r) => {
					markStarted = r;
				});
			};
			const sysModel = new SystemModelSettings(db, registry);
			sysModel.set({
				model: { provider: "mock", model: "light" },
				tasks: { sessionTitle: true, sessionPurpose: true, sessionName: false, groupName: false },
				refreshEvery: 2,
			});

			const describer = new SessionDescriber({
				store,
				registry,
				systemModel: sysModel,
				isClosing: () => false,
				updateSession: (id, patch) => store.update(id, patch),
			});

			const makeSession = (id: string, title: string, name: string, purpose: string) => {
				const now = Date.now();
				store.create({
					id,
					title,
					name,
					purpose,
					cwd: unitDir,
					provider: "mock",
					model: "light",
					thinkingLevel: "off",
					systemPrompt: "",
					tools: [],
					parentId: null,
					closed: false,
					createdAt: now,
					updatedAt: now,
				});
				return id;
			};

			// Seed session A with auto-written title/purpose at userMessageCount = 1
			const sessA = makeSession("s-a", "Auto title", "A1", "auto purpose");
			store.appendMessage(sessA, 0, { role: "user", content: "first prompt", timestamp: 1 });
			store.appendMessage(sessA, 1, { role: "user", content: "second prompt", timestamp: 2 });
			store.setDescribeState(sessA, { titleAuto: true, purposeAuto: true, lastUserCount: 1 });

			// Trigger refresh on 3rd prompt (delta = 2 >= refreshEvery = 2), then manually rename title mid-flight
			const jobA = describer.describe(sessA, undefined, "third prompt");
			expect(jobA).toBeDefined();
			await callStarted;
			expect(callCount).toBe(1);
			store.update(sessA, { title: "User renamed mid-flight" });
			describer.markManual(sessA, { title: true });
			resolveCall('{"title": "Stale auto title", "purpose": "updated purpose"}');
			await jobA;
			expect(store.get(sessA)?.title).toBe("User renamed mid-flight");
			expect(store.get(sessA)?.purpose).toBe("updated purpose");
			expect(store.describeState(sessA)).toEqual({ titleAuto: false, purposeAuto: true, lastUserCount: 3 });

			// Rewind: if messages drop below lastUserCount, describe/maybeRefresh resets lastUserCount cleanly without firing
			store.setDescribeState(sessA, { titleAuto: false, purposeAuto: true, lastUserCount: 10 });
			expect(describer.maybeRefresh(sessA)).toBeUndefined();
			expect(store.describeState(sessA).lastUserCount).toBe(2);

			// Session deleted mid-flight: resolves cleanly without throwing FK errors
			const sessB = makeSession("s-b", "Auto B", "B1", "purpose B");
			store.appendMessage(sessB, 0, { role: "user", content: "msg 1", timestamp: 1 });
			store.appendMessage(sessB, 1, { role: "user", content: "msg 2", timestamp: 2 });
			store.appendMessage(sessB, 2, { role: "user", content: "msg 3", timestamp: 3 });
			store.setDescribeState(sessB, { titleAuto: true, purposeAuto: true, lastUserCount: 1 });
			nextCall();
			const jobB = describer.maybeRefresh(sessB);
			expect(jobB).toBeDefined();
			await callStarted;
			store.delete(sessB);
			resolveCall('{"title": "After delete", "purpose": "after delete"}');
			await jobB;
			expect(store.get(sessB)).toBeUndefined();
		} finally {
			db.close();
			rmSync(unitDir, { recursive: true, force: true });
		}
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

describe("follow-up suggestions", () => {
	test("parseFollowUpSuggestions extracts, cleans, deduplicates, and caps suggestions", () => {
		expect(
			parseFollowUpSuggestions('```json\n{"suggestions": ["1. 테스트 실행해 줘", "- 엣지 케이스 확인", "테스트 실행해 줘", "  ", "?", "네 번째는 잘림"]}\n```'),
		).toEqual(["테스트 실행해 줘", "엣지 케이스 확인", "네 번째는 잘림"]);
		expect(parseFollowUpSuggestions('["Run tests", "Add docs"]')).toEqual(["Run tests", "Add docs"]);
		expect(parseFollowUpSuggestions('{"suggestions": []}')).toEqual([]);
		expect(parseFollowUpSuggestions("no json here")).toEqual([]);
		expect(parseFollowUpSuggestions('{"suggestions": [null, 42, ""]}')).toEqual([]);
		const long = "a".repeat(150);
		const parsed = parseFollowUpSuggestions(JSON.stringify({ suggestions: [long] }));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.length).toBeLessThanOrEqual(120);
		expect(parsed[0]!.endsWith("…")).toBe(true);
	});

	test("followUpRequest clips long replies keeping head and tail, and omits empty user text", () => {
		const longReply = `${"H".repeat(2000)}${"M".repeat(1000)}${"T".repeat(1500)}`;
		const req = followUpRequest({ userPrompt: "How does it work?", assistantReply: longReply });
		expect(req).toContain("<user_message>\nHow does it work?\n</user_message>");
		expect(req).toContain("<assistant_reply>\n");
		expect(req).toContain("\n…\n");
		expect(req).toContain("HHH");
		expect(req).toContain("TTT");
		expect(followUpRequest({ userPrompt: "   ", assistantReply: "Done." })).not.toContain("<user_message>");
	});

	test("toggle controls follow-up suggestion generation, event publishing, status hydration, and clearing", async () => {
		// Off by default -> no follow-up suggestion call
		await api("PUT", "/system-model", {
			model: { provider: "echo", model: LIGHT.id },
			tasks: { sessionTitle: false, sessionPurpose: false, sessionName: false, groupName: false, followUpSuggestions: false },
		});
		const id = await newSession();
		const events: { type: string; data: Record<string, unknown> }[] = [];
		const unsub = app.bus.subscribe((e) => {
			if (e.sessionId === id && e.type === "follow_up_suggestions") events.push({ type: e.type, data: e.data as Record<string, unknown> });
		}, id);
		try {
			upstream.requests.length = 0;
			await api("POST", `/sessions/${id}/messages`, { text: '{"suggestions": ["테스트 돌려줘", "PR 만들어줘"]}' });
			await settle();
			expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
			expect(events).toHaveLength(0);
			expect((await api("GET", `/sessions/${id}`)).json.status.followUpSuggestions).toBeUndefined();

			// Turn followUpSuggestions on -> completed user turn generates suggestions
			await api("PUT", "/system-model", {
				model: { provider: "echo", model: LIGHT.id },
				tasks: { followUpSuggestions: true },
			});
			upstream.requests.length = 0;
			// Echo upstream returns the prompt verbatim, so embed a valid suggestions JSON inside the user message.
			await api("POST", `/sessions/${id}/messages`, { text: 'Summary please {"suggestions": ["테스트 실행해 줘", "문서도 업데이트해 줘"]}' });
			await settle();
			expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(1);
			expect(events).toHaveLength(1);
			expect(events[0]!.data.suggestions).toEqual(["테스트 실행해 줘", "문서도 업데이트해 줘"]);
			expect(typeof events[0]!.data.afterSeq).toBe("number");
			expect((await api("GET", `/sessions/${id}`)).json.status.followUpSuggestions).toEqual(["테스트 실행해 줘", "문서도 업데이트해 줘"]);

			// Turning followUpSuggestions off immediately clears cached suggestions and notifies clients
			await api("PUT", "/system-model", {
				model: { provider: "echo", model: LIGHT.id },
				tasks: { followUpSuggestions: false },
			});
			expect((await api("GET", `/sessions/${id}`)).json.status.followUpSuggestions).toBeUndefined();
			expect(events).toHaveLength(2);
			expect(events[1]!.data).toEqual({ afterSeq: -1, suggestions: [] });

			// Re-enable and verify non-user (peer) turns do not generate suggestions
			await api("PUT", "/system-model", {
				model: { provider: "echo", model: LIGHT.id },
				tasks: { followUpSuggestions: true },
			});
			upstream.requests.length = 0;
			await app.sessions.send(id, { text: '{"suggestions": ["Should not run"]}', origin: "peer" });
			await settle();
			expect(upstream.requests.filter((r) => r.body.model === LIGHT.id)).toHaveLength(0);
			expect((await api("GET", `/sessions/${id}`)).json.status.followUpSuggestions).toBeUndefined();
		} finally {
			unsub();
			await api("PUT", "/system-model", {
				model: null,
				tasks: DEFAULT_SYSTEM_MODEL_TASKS(),
			});
		}
	});

	test("SessionSuggester discards stale in-flight suggestions when a new message arrives or session is deleted", async () => {
		const unitDir = mkdtempSync(join(tmpdir(), "pipaya-suggester-unit-"));
		const db = openDb(join(unitDir, "db.sqlite"));
		try {
			const store = new SessionStore(db);
			const modelObj = { id: LIGHT.id, provider: "echo", api: "openai-completions", reasoning: false };
			let callStartedResolve!: () => void;
			let callStarted = new Promise<void>((r) => { callStartedResolve = r; });
			let resolveCall!: (text: string) => void;
			const registry = {
				models: {
					getModel: (p: string, m: string) => (p === "echo" && m === LIGHT.id ? modelObj : undefined),
					checkAuth: async () => true,
					completeSimple: (_m: unknown, _ctx: unknown, opts: { signal?: AbortSignal }) => {
						callStartedResolve();
						return new Promise((resolve, reject) => {
							opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							resolveCall = (text: string) =>
								resolve({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() });
						});
					},
				},
			};
			const systemModel = new SystemModelSettings(db, registry as never);
			systemModel.set({
				model: { provider: "echo", model: LIGHT.id },
				tasks: { sessionTitle: false, sessionPurpose: false, sessionName: false, groupName: false, followUpSuggestions: true },
			});
			const published: { id: string; afterSeq: number; suggestions: string[] }[] = [];
			let idle = true;
			const suggester = new SessionSuggester({
				store,
				registry: registry as never,
				systemModel,
				isClosing: () => false,
				isSessionIdle: () => idle,
				hasPendingQuestions: () => false,
				publish: (id, payload) => published.push({ id, ...payload }),
			});

			const makeSession = (id: string, name: string) => {
				const now = Date.now();
				store.create({
					id,
					title: "Test",
					name,
					purpose: "",
					cwd: unitDir,
					provider: "echo",
					model: ECHO_MODEL.id,
					thinkingLevel: "off",
					systemPrompt: "",
					tools: [],
					parentId: null,
					closed: false,
					createdAt: now,
					updatedAt: now,
				});
				return id;
			};
			const assistantMsg = (text: string, timestamp: number) => ({
				role: "assistant" as const,
				content: [{ type: "text" as const, text }],
				api: "openai-completions",
				provider: "echo",
				model: ECHO_MODEL.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
				timestamp,
			});

			// Case 1: New message appended before completion -> stale result discarded
			const s1 = makeSession("sug-1", "S1");
			store.appendMessage(s1, 0, { role: "user", content: "Explain caching", timestamp: 1 });
			store.appendMessage(s1, 1, assistantMsg("Caching stores hot results.", 2));
			const job1 = suggester.generate(s1, 1);
			expect(job1).toBeDefined();
			await callStarted;
			// New user message arrives before the model answers
			store.appendMessage(s1, 2, { role: "user", content: "Next question", timestamp: 3 });
			resolveCall('{"suggestions": ["Stale suggestion"]}');
			await job1;
			expect(published).toHaveLength(0);
			expect(suggester.get(s1, 1)).toEqual([]);
			expect(suggester.get(s1, 2)).toEqual([]);

			// Case 2: Session deleted while in flight -> never publishes
			callStarted = new Promise<void>((r) => { callStartedResolve = r; });
			const s2 = makeSession("sug-2", "S2");
			store.appendMessage(s2, 0, { role: "user", content: "Hello", timestamp: 1 });
			store.appendMessage(s2, 1, assistantMsg("Hi there!", 2));
			const job2 = suggester.generate(s2, 1);
			await callStarted;
			store.delete(s2);
			resolveCall('{"suggestions": ["After delete"]}');
			await job2;
			expect(published).toHaveLength(0);

			// Case 3: Normal idle completion caches & publishes, and clear() aborts/notifies
			callStarted = new Promise<void>((r) => { callStartedResolve = r; });
			idle = true;
			const s3 = makeSession("sug-3", "S3");
			store.appendMessage(s3, 0, { role: "user", content: "Write tests", timestamp: 1 });
			store.appendMessage(s3, 1, assistantMsg("Tests written.", 2));
			const job3 = suggester.generate(s3, 1);
			await callStarted;
			resolveCall('{"suggestions": ["Run them now", "Check coverage"]}');
			await job3;
			expect(published).toEqual([{ id: s3, afterSeq: 1, suggestions: ["Run them now", "Check coverage"] }]);
			expect(suggester.get(s3, 1)).toEqual(["Run them now", "Check coverage"]);
			expect(suggester.get(s3, 2)).toEqual([]);

			suggester.clear(s3, { notify: true });
			expect(suggester.get(s3, 1)).toEqual([]);
			expect(published).toHaveLength(2);
			expect(published[1]).toEqual({ id: s3, afterSeq: -1, suggestions: [] });
		} finally {
			db.close();
			rmSync(unitDir, { recursive: true, force: true });
		}
	});
});
