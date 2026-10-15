import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

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
const untilIdle = async (id: string) => {
	for (let i = 0; i < 300; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
};
const messages = async (id: string) => ((await api("GET", `/sessions/${id}/messages`)).json.messages as any[]).map((m) => m.message);
const newSession = async (extra: object = {}) => (await api("POST", "/sessions", { cwd: ws, approval: "auto", ...extra })).json.id as string;

const EXT = `
export default (pi) => {
	const T = pi.Type;
	pi.registerFlag("shout", { type: "boolean", default: false });
	pi.registerTool({
		name: "greet",
		description: "Greets someone",
		parameters: T.Object({ who: T.String() }),
		mutating: false,
		execute: async (_id, p, ctx) => {
			ctx.appendEntry("greeted", { who: p.who });
			return { content: [{ type: "text", text: "hello " + p.who }], details: {} };
		},
	});
	pi.registerCommand("ping", { description: "pong", handler: async (args, ctx) => { ctx.appendEntry("ping", { args }); } });
	pi.registerCommand("ask", { handler: async (args) => "rewritten: " + args });
	pi.registerMethod("sum", (p) => (p.a + p.b));
	pi.on("input", (e) => (e.text === "swallow me" ? { handled: true } : undefined));
	pi.on("tool_call", (e) => {
		if (e.toolName === "bash" && String(e.args.command).includes("forbidden")) return { block: true, reason: "nope from extension" };
		if (e.toolName === "read" && String(e.args.path).includes("secret")) return { block: true, reason: "no secrets" };
	});
	pi.on("tool_result", (e) => (e.toolName === "greet" ? { content: [{ type: "text", text: "REDACTED" }] } : undefined));
	pi.on("before_agent_start", () => ({ appendSystemPrompt: "EXTENSION-PROMPT" }));
	pi.on("context", (e) => ({ messages: e.messages }));
	pi.on("session_before_compact", () => undefined);
	pi.events.on("x", (d) => pi.emit(null, "got-x", d, { ephemeral: true }));
};
`;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-ext-"));
	ws = join(dir, "ws");
	extDir = join(dir, "exts");
	mkdirSync(ws, { recursive: true });
	mkdirSync(extDir, { recursive: true });
	writeFileSync(join(extDir, "demo.js"), EXT);
	writeFileSync(join(extDir, "broken.js"), "export default () => { throw new Error('boom'); };");
	upstream = startEchoUpstream();
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, extensionDirs: [extDir], home: dir });
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("server extensions", () => {
	test("loads good extensions, isolates a broken one and reports both", async () => {
		const { extensions } = (await api("GET", "/server-extensions")).json;
		const demo = extensions.find((e: any) => e.name === "demo");
		expect(demo.error).toBeUndefined();
		expect(demo.tools).toEqual(["greet"]);
		expect(demo.commands.map((c: any) => c.name)).toEqual(["ping", "ask"]);
		expect(extensions.find((e: any) => e.name === "broken").error).toContain("boom");
		expect((await api("GET", "/server-extensions/errors")).json.errors.some((e: any) => e.extension === "broken")).toBe(true);
	});

	test("an extension tool is listed, usable by the model, and its result can be rewritten by tool_result", async () => {
		const tools = (await api("GET", "/tools")).json;
		expect(tools.tools.find((t: any) => t.name === "greet")).toMatchObject({ mutating: false });
		expect(tools.defaults).toContain("greet");
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: `!greet ${JSON.stringify({ who: "Ada" })}` });
		await untilIdle(id);
		const result = (await messages(id)).find((m) => m.role === "toolResult" && m.toolName === "greet");
		expect(result.content[0].text).toBe("REDACTED");
		const entries = (await api("GET", `/sessions/${id}/extension-entries?extension=demo`)).json.entries;
		expect(entries).toMatchObject([{ extension: "demo", type: "greeted", data: { who: "Ada" } }]);
	});

	test("tool_call can block a tool before it runs", async () => {
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: `!bash ${JSON.stringify({ command: "echo forbidden > f.txt" })}` });
		await untilIdle(id);
		const result = (await messages(id)).find((m) => m.role === "toolResult" && m.toolName === "bash");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("nope from extension");
	});

	test("a sub-agent cannot get around the tool_call hook of the calling session", async () => {
		writeFileSync(join(ws, "secret.txt"), "TOP-SECRET-VALUE");
		expect((await api("PUT", "/subagents", { settings: { enabled: true, agents: [{ name: "explore", description: "reads", enabled: true, model: null, tools: ["read", "grep", "ls"], maxTurns: 6, prompt: "" }] } })).status).toBe(200);
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: `!delegate ${JSON.stringify({ task: `!read ${JSON.stringify({ path: "secret.txt" })}` })}` });
		await untilIdle(id);
		const result = (await messages(id)).find((m) => m.role === "toolResult" && m.toolName === "delegate");
		expect(JSON.stringify(result)).not.toContain("TOP-SECRET-VALUE");
		// Guard against passing for the wrong reason: the helper really ran and was refused by the hook.
		expect(result.isError).toBeFalsy();
		expect(upstream.requests.some((r) => JSON.stringify(r.body).includes("no secrets"))).toBe(true);
	});

	test("/commands run in the server; a returned string becomes the prompt; input hook can swallow", async () => {
		const id = await newSession();
		await api("POST", `/sessions/${id}/messages`, { text: "/ping hi" });
		await untilIdle(id);
		expect(await messages(id)).toEqual([]);
		expect((await api("GET", `/sessions/${id}/extension-entries?type=ping`)).json.entries[0].data).toEqual({ args: "hi" });

		await api("POST", `/sessions/${id}/messages`, { text: "swallow me" });
		expect(await messages(id)).toEqual([]);

		await api("POST", `/sessions/${id}/messages`, { text: "/ask hello" });
		await untilIdle(id);
		expect(JSON.stringify((await messages(id))[0])).toContain("rewritten: hello");
	});

	test("before_agent_start adds to the system prompt of the run", async () => {
		const id = await newSession();
		upstream.requests.length = 0;
		await api("POST", `/sessions/${id}/messages`, { text: "hello" });
		await untilIdle(id);
		const sys = upstream.requests.at(-1)!.body.messages.find((m: any) => m.role === "system");
		expect(JSON.stringify(sys)).toContain("EXTENSION-PROMPT");
	});

	test("flags read PIPAYA_FLAG_<NAME> and fall back to the default", async () => {
		const flags = (await api("GET", "/server-extensions")).json.extensions.find((e: any) => e.name === "demo").flags;
		expect(flags).toMatchObject([{ name: "shout", type: "boolean", value: false }]);
		process.env.PIPAYA_FLAG_SHOUT = "1";
		try {
			expect((await api("GET", "/server-extensions")).json.extensions.find((e: any) => e.name === "demo").flags[0].value).toBe(true);
		} finally {
			delete process.env.PIPAYA_FLAG_SHOUT;
		}
	});

	test("extension_unload runs on reload so an extension can release what it opened", async () => {
		const marker = join(dir, "unloaded.txt");
		writeFileSync(join(extDir, "closer.js"), `import { appendFileSync } from "node:fs";
export default (pi) => { pi.on("extension_unload", () => appendFileSync(${JSON.stringify(marker)}, "x")); };`);
		await api("POST", "/server-extensions/reload");
		expect(existsSync(marker)).toBe(false);
		await api("POST", "/server-extensions/reload");
		expect(readFileSync(marker, "utf8")).toBe("x");
		rmSync(join(extDir, "closer.js"));
		await api("POST", "/server-extensions/reload");
	});

	test("methods are callable by clients and reload keeps working", async () => {
		expect((await api("POST", "/server-extensions/demo/methods/sum", { a: 2, b: 3 })).json.result).toBe(5);
		expect((await api("POST", "/server-extensions/demo/methods/nope", {})).status).toBe(404);
		expect((await api("POST", "/server-extensions/reload")).status).toBe(200);
		expect((await api("POST", "/server-extensions/demo/methods/sum", { a: 1, b: 1 })).json.result).toBe(2);
	});
});

describe("examples/extensions/todo.ts", () => {
	test("loads, adds a todo through the model's tool, blocks rm -rf /, and counts per session", async () => {
		const exDir = join(dir, "example-exts");
		mkdirSync(exDir, { recursive: true });
		writeFileSync(join(exDir, "todo.ts"), readFileSync(join(import.meta.dir, "../examples/extensions/todo.ts"), "utf8"));
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: join(dir, "ex-data"), dbPath: join(dir, "ex.sqlite"), token: "test-token", workspaceRoot: ws, defaultApproval: "auto", approvalTimeoutMs: 1000, logLevel: "silent" };
		const other = await buildApp(cfg, { strictResponses: true, extensionDirs: [exDir], home: dir });
		const call = async (method: any, url: string, payload?: unknown) => {
			const r = await other.server.inject({ method, url, headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
			return { status: r.statusCode, json: r.body ? r.json() : undefined };
		};
		try {
			expect((await call("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await call("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
			const listed = (await call("GET", "/server-extensions")).json.extensions[0];
			expect(listed.error).toBeUndefined();
			expect(listed.tools).toEqual(["todo_add"]);
			const id = (await call("POST", "/sessions", { cwd: ws, approval: "ask" })).json.id as string;
			// mutating:false means the tool runs without an approval prompt even in `ask` mode
			await call("POST", `/sessions/${id}/messages`, { text: `!todo_add ${JSON.stringify({ text: "write docs" })}` });
			for (let i = 0; i < 300 && (await call("GET", `/sessions/${id}/status`)).json.running; i++) await Bun.sleep(20);
			expect((await call("GET", `/sessions/${id}/extension-entries?type=todo`)).json.entries.map((e: any) => e.data)).toEqual([{ text: "write docs", done: false }]);
			expect((await call("POST", `/server-extensions/todo/methods/count?sessionId=${id}`, {})).json.result).toBe(1);
			expect((await call("POST", "/server-extensions/todo/methods/count", {})).json.result).toBe(0);
			const id2 = (await call("POST", "/sessions", { cwd: ws, approval: "auto" })).json.id as string;
			await call("POST", `/sessions/${id2}/messages`, { text: `!bash ${JSON.stringify({ command: "rm -rf /" })}` });
			for (let i = 0; i < 300 && (await call("GET", `/sessions/${id2}/status`)).json.running; i++) await Bun.sleep(20);
			const res = ((await call("GET", `/sessions/${id2}/messages`)).json.messages as any[]).map((m) => m.message).find((m) => m.role === "toolResult");
			expect(JSON.stringify(res)).toContain("Refused by the todo example");
		} finally {
			await other.close();
		}
	});
});

