import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

const TOKEN = "test-token-builtin";
const DAY = 24 * 3600_000;
let app: App;
let dir: string;
let home: string;
let ws: string;
let db: Database;
let upstream: EchoUpstream;

const api = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method, url,
		headers: { authorization: `Bearer ${TOKEN}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const idle = async (id: string) => {
	for (let i = 0; i < 300; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
};
const call = async (ext: string, method: string, body: unknown = {}) => (await api("POST", `/server-extensions/${ext}/methods/${method}`, body)).json?.result;
const make = async (extra: object = {}) => (await api("POST", "/sessions", { cwd: ws, approval: "auto", ...extra })).json.id as string;
const exists = async (id: string) => (await api("GET", `/sessions/${id}`)).status === 200;
const aged = async (days: number) => {
	const id = await make();
	db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() - days * DAY });
	return id;
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-builtin-ext-"));
	home = join(dir, "home");
	ws = join(dir, "ws");
	mkdirSync(join(home, ".agents", "templates"), { recursive: true });
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(home, ".agents", "templates", "review.md"), "---\ndescription: Review a change\n---\nReview this: $ARGUMENTS");
	// the example the docs point to is installed the way a user would: copied into an extensions folder
	const userExt = join(dir, "user-ext");
	mkdirSync(userExt, { recursive: true });
	cpSync(join(import.meta.dir, "..", "examples", "extensions", "session-retention.ts"), join(userExt, "session-retention.ts"));
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 0, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, home, extensionDirs: [userExt, join(import.meta.dir, "support/ext")] });
	await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl));
	await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id });
	db = new Database(join(dir, "db.sqlite"), { strict: true });
});
afterAll(async () => {
	db.close();
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("bundled extensions", () => {
	test("prompt-templates and peer-tools load with the server; retention is only an example", async () => {
		const list = (await api("GET", "/server-extensions")).json.extensions as { name: string; tools: string[]; error?: string }[];
		expect(list.filter((e) => e.error)).toEqual([]);
		expect(list.find((e) => e.name === "peer-tools")?.tools).toEqual(["peer_send", "peer_read"]);
		expect(list.some((e) => e.name === "prompt-templates")).toBe(true);
	});

	test("a user's extension with the same name replaces the bundled one", async () => {
		const other = mkdtempSync(join(tmpdir(), "pipaya-builtin-over-"));
		mkdirSync(join(other, "x"), { recursive: true });
		writeFileSync(join(other, "peer-tools.ts"), "export default (pi) => pi.registerMethod('mine', () => 1);");
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: other, dbPath: join(other, "db.sqlite"), token: TOKEN, workspaceRoot: other, defaultApproval: "auto", approvalTimeoutMs: 0, logLevel: "silent" };
		const o = await buildApp(cfg, { home, extensionDirs: [other] });
		const r = await o.server.inject({ method: "GET", url: "/server-extensions", headers: { authorization: `Bearer ${TOKEN}` } });
		const peer = r.json().extensions.filter((e: any) => e.name === "peer-tools");
		expect(peer.length).toBe(1);
		expect(peer[0].methods).toEqual(["mine"]);
		await o.close();
		rmSync(other, { recursive: true, force: true });
	});

	test("the peer tools can be switched off in the settings, like delegate", async () => {
		const info = (await api("GET", "/configuration")).json.tools;
		expect(info.toggleable).toEqual(["delegate", "peer_send", "peer_read"]);
		expect((await api("PUT", "/configuration/tools", { disabled: ["peer_send"] })).json.disabled).toEqual(["peer_send"]);
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: `!peer_send ${JSON.stringify({ to: "x", message: "y" })}` });
		await idle(id);
		expect(JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json)).not.toContain("session @x");
		expect((await api("PUT", "/configuration/tools", { disabled: [] })).json.disabled).toEqual([]);
	});
});

describe("prompt-templates", () => {
	test("lists the templates of a directory for the client", async () => {
		const r = await call("prompt-templates", "list", { cwd: ws });
		expect(r.templates.map((t: any) => t.name)).toEqual(["review"]);
		expect(r.templates[0].description).toBe("Review a change");
	});

	test("/prompt:name is sent as the expanded text with a marker note, and titles the session by the name", async () => {
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: "/prompt:review the diff" });
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		const user = JSON.stringify(msgs.find((m: any) => m.role === "user"));
		expect(user).toContain("Review this: the diff");
		expect(user).toContain("<pipaya-template>");
		expect(user).toContain("/prompt:review the diff");
		expect((await api("GET", `/sessions/${id}`)).json.title).toBe("review");
	});

	test("an unknown template is sent as typed", async () => {
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: "/prompt:nope hi" });
		await idle(id);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages.map((m: any) => m.message);
		expect(JSON.stringify(msgs.find((m: any) => m.role === "user"))).toContain("/prompt:nope hi");
	});

	test("core no longer serves /templates", async () => {
		expect((await api("GET", "/templates")).status).toBe(404);
	});
});

describe("session retention (an example extension)", () => {
	test("core has no policy of its own and never deletes by itself", async () => {
		expect((await api("GET", "/sessions/retention")).status).not.toBe(200);
		const old = await aged(900);
		expect(await exists(old)).toBe(true);
	});

	test("off until a policy is set; then it deletes old sessions and keeps the rest", async () => {
		const old = await aged(45), edge = await aged(29), fresh = await aged(0);
		expect((await call("session-retention", "run")).deleted).toBe(0);
		await expect(call("session-retention", "setPolicy", { enabled: true, days: 0 })).resolves.toBeUndefined();
		const set = await call("session-retention", "setPolicy", { enabled: true, days: 30, onlyClosed: false });
		expect(set.policy).toEqual({ enabled: true, days: 30, onlyClosed: false });
		expect(set.due).toBeGreaterThanOrEqual(1);
		expect((await call("session-retention", "run")).deleted).toBeGreaterThanOrEqual(1);
		expect(await exists(old)).toBe(false);
		expect(await exists(edge)).toBe(true);
		expect(await exists(fresh)).toBe(true);
		expect((await call("session-retention", "info")).lastRun).toBeGreaterThan(0);
	});

	test("with only-closed, an old active session is kept", async () => {
		await call("session-retention", "setPolicy", { enabled: true, days: 30, onlyClosed: true });
		const active = await aged(90), closed = await aged(90);
		await api("PATCH", `/sessions/${closed}`, { closed: true });
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id: closed, t: Date.now() - 90 * DAY });
		await call("session-retention", "run");
		expect(await exists(active)).toBe(true);
		expect(await exists(closed)).toBe(false);
	});

	test("a session that is waiting for the user is never deleted, however old", async () => {
		await call("session-retention", "setPolicy", { enabled: true, days: 1, onlyClosed: false });
		const id = await make();
		await api("POST", `/sessions/${id}/messages`, { text: `!ask_user ${JSON.stringify({ question: "Still here?" })}` });
		for (let i = 0; i < 100 && !(await api("GET", `/questions?sessionId=${id}`)).json.questions.length; i++) await Bun.sleep(20);
		db.query("UPDATE sessions SET updated_at = $t WHERE id = $id").run({ id, t: Date.now() - 400 * DAY });
		await call("session-retention", "run");
		expect(await exists(id)).toBe(true);
		await api("POST", `/sessions/${id}/abort`);
	});
});
