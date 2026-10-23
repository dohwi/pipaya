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
const newSession = async (extra: object = {}) => (await api("POST", "/sessions", { cwd: ws, ...extra })).json.id as string;

const EXT = `
export default (pi) => {
	const T = pi.Type;
	pi.registerFlag("shout", { type: "boolean", default: false });
	pi.registerTool({
		name: "greet",
		description: "Greets someone",
		parameters: T.Object({ who: T.String() }),
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
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
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
		expect(tools.tools.find((t: any) => t.name === "greet")).toBeTruthy();
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

	test("pipaya.companion in package.json is reported as the client extension this one needs", async () => {
		const pkgDir = join(extDir, "paired");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pipaya: { companion: "paired-ui" } }));
		writeFileSync(join(pkgDir, "index.js"), "export default () => {};");
		await api("POST", "/server-extensions/reload");
		const list = (await api("GET", "/server-extensions")).json.extensions as any[];
		expect(list.find((e) => e.name === "paired")?.companion).toBe("paired-ui");
		expect(list.find((e) => e.name === "demo")?.companion).toBeUndefined();
		rmSync(pkgDir, { recursive: true });
		await api("POST", "/server-extensions/reload");
	});

	test("methods are callable by clients and reload keeps working", async () => {
		expect((await api("POST", "/server-extensions/demo/methods/sum", { a: 2, b: 3 })).json.result).toBe(5);
		expect((await api("POST", "/server-extensions/demo/methods/nope", {})).status).toBe(404);
		expect((await api("POST", "/server-extensions/reload")).status).toBe(200);
		expect((await api("POST", "/server-extensions/demo/methods/sum", { a: 1, b: 1 })).json.result).toBe(2);
	});
});

describe("ctx.ask", () => {
	test("an extension tool can ask the user and gets the answer", async () => {
		const exDir = join(dir, "ask-exts");
		mkdirSync(exDir, { recursive: true });
		writeFileSync(join(exDir, "asker.ts"), `export default (pi) => pi.registerTool({ name: "ask_ext", description: "asks", parameters: pi.Type.Object({}),
			execute: async (id, _p, ctx, signal) => ({ content: [{ type: "text", text: "got " + await ctx.ask(id, { question: "Which?", options: ["a", "b"], allowFreeText: false }, signal) }] }) });`);
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: join(dir, "ask-data"), dbPath: join(dir, "ask.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		const other = await buildApp(cfg, { strictResponses: true, extensionDirs: [exDir], home: dir });
		const call = async (method: any, url: string, payload?: unknown) => {
			const r = await other.server.inject({ method, url, headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
			return { status: r.statusCode, json: r.body ? r.json() : undefined };
		};
		try {
			expect((await call("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await call("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
			const id = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
			await call("POST", `/sessions/${id}/messages`, { text: "!ask_ext {}" });
			let q: any;
			for (let i = 0; i < 100 && !q; i++) { q = (await call("GET", `/questions?sessionId=${id}`)).json.questions[0]; await Bun.sleep(20); }
			expect(q).toMatchObject({ question: "Which?", options: ["a", "b"], allowFreeText: false });
			expect((await call("POST", `/sessions/${id}/questions/${q.toolCallId}`, { answer: "zzz" })).status).toBe(400);
			expect((await call("POST", `/sessions/${id}/questions/${q.toolCallId}`, { answer: "b" })).status).toBe(200);
			for (let i = 0; i < 300 && (await call("GET", `/sessions/${id}/status`)).json.running; i++) await Bun.sleep(20);
			const res = ((await call("GET", `/sessions/${id}/messages`)).json.messages as any[]).map((m) => m.message).find((m) => m.role === "toolResult");
			expect(JSON.stringify(res)).toContain("got b");
		} finally {
			await other.close();
		}
	});
});

describe("examples/extensions/todo.ts", () => {
	test("loads, adds a todo through the model's tool, blocks rm -rf /, and counts per session", async () => {
		const exDir = join(dir, "example-exts");
		mkdirSync(exDir, { recursive: true });
		writeFileSync(join(exDir, "todo.ts"), readFileSync(join(import.meta.dir, "../examples/extensions/todo.ts"), "utf8"));
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: join(dir, "ex-data"), dbPath: join(dir, "ex.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
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
			const id = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
			await call("POST", `/sessions/${id}/messages`, { text: `!todo_add ${JSON.stringify({ text: "write docs" })}` });
			for (let i = 0; i < 300 && (await call("GET", `/sessions/${id}/status`)).json.running; i++) await Bun.sleep(20);
			expect((await call("GET", `/sessions/${id}/extension-entries?type=todo`)).json.entries.map((e: any) => e.data)).toEqual([{ text: "write docs", done: false }]);
			expect((await call("POST", `/server-extensions/todo/methods/count?sessionId=${id}`, {})).json.result).toBe(1);
			expect((await call("POST", "/server-extensions/todo/methods/count", {})).json.result).toBe(0);
			const id2 = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
			await call("POST", `/sessions/${id2}/messages`, { text: `!bash ${JSON.stringify({ command: "rm -rf /" })}` });
			for (let i = 0; i < 300 && (await call("GET", `/sessions/${id2}/status`)).json.running; i++) await Bun.sleep(20);
			const res = ((await call("GET", `/sessions/${id2}/messages`)).json.messages as any[]).map((m) => m.message).find((m) => m.role === "toolResult");
			expect(JSON.stringify(res)).toContain("Refused by the todo example");
		} finally {
			await other.close();
		}
	});
});


describe("generic extension API", () => {
	const GENERIC = `
export default (pi) => {
	const seen = [];
	pi.subscribe((e) => seen.push(e.type), { types: ["session_created", "group_created"] });
	pi.registerMethod("seen", () => seen);
	pi.registerMethod("make", async (p) => {
		const a = await pi.sessions.create({ title: "made", cwd: p.cwd });
		const b = await pi.sessions.create({ title: "other", cwd: p.cwd, parentId: a.id });
		const renamed = pi.sessions.update(a.id, { title: "renamed", purpose: "testing" });
		const group = pi.groups.create({ name: "pair", layout: { type: "split", dir: "row", ratio: 0.5, a: { type: "pane", sessionId: a.id }, b: { type: "pane", sessionId: b.id } } });
		const fork = await pi.sessions.fork(a.id, { title: "copy" });
		return { a: renamed, b, group, fork, groups: pi.groups.list().length, abort: pi.sessions.abort(a.id), questions: pi.sessions.questions(a.id) };
	});
	pi.registerMethod("ungroup", (p) => pi.groups.delete(p.id));
	pi.registerMethod("models", async () => (await pi.models.list()).map((m) => m.provider + "/" + m.id));
	pi.registerMethod("complete", async () => (await pi.models.complete({ input: "hi there" })).text);
	pi.registerMethod("notify", () => { pi.notify({ title: "hello", kind: "info" }); return true; });
	pi.registerMethod("settings", (p) => (p ? pi.settings.set(p) : pi.settings.get()));
	let changed = 0;
	pi.settings.onChange(() => { changed++; });
	pi.registerMethod("changed", () => changed);
	pi.registerCommands("snip", {
		label: "Snippets",
		list: (cwd) => [{ name: "hello", description: "says hi in " + cwd.split("/").pop() }, { name: "bad name!" }],
		run: (name, args) => ({ prompt: "SNIPPET " + name + " " + args, note: { text: "snippet: " + name, collapse: true, data: { name } }, title: name }),
	});
	pi.on("input", (e) => (e.text === "noted" ? { note: { text: "a note" } } : undefined));
};`;
	let other: App;
	const call = async (method: any, url: string, payload?: unknown) => {
		const r = await other.server.inject({ method, url, headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const method = async (name: string, params: unknown = {}) => (await call("POST", `/server-extensions/gen/methods/${name}`, params)).json;
	const idle = async (id: string) => { for (let i = 0; i < 300 && (await call("GET", `/sessions/${id}/status`)).json.running; i++) await Bun.sleep(20); };

	beforeAll(async () => {
		const exDir = join(dir, "generic-exts");
		mkdirSync(exDir, { recursive: true });
		writeFileSync(join(exDir, "gen.js"), GENERIC);
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: join(dir, "gen-data"), dbPath: join(dir, "gen.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
		other = await buildApp(cfg, { strictResponses: true, extensionDirs: [exDir], home: dir });
		expect((await call("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
		expect((await call("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
	});
	afterAll(async () => { await other.close(); });

	test("sessions and groups can be created, changed, forked and removed; events reach subscribe()", async () => {
		const r = (await method("make", { cwd: ws })).result;
		expect(r.a).toMatchObject({ title: "renamed", purpose: "testing", provider: "echo", model: ECHO_MODEL.id, cwd: ws });
		expect(r.b.parentId).toBe(r.a.id);
		expect(r.group.sessionIds).toEqual([r.a.id, r.b.id]);
		expect(r.fork.title).toBe("copy");
		expect(r.abort).toBe(false);
		expect(r.questions).toEqual([]);
		expect((await method("ungroup", { id: r.group.id })).result).toBe(true);
		expect((await method("ungroup", { id: r.group.id })).result).toBe(false);
		const seen = (await method("seen")).result as string[];
		expect(seen.filter((t) => t === "session_created")).toHaveLength(3);
		expect(seen).toContain("group_created");
	});

	test("models can be listed and used for a one-shot completion", async () => {
		expect((await method("models")).result).toContain(`echo/${ECHO_MODEL.id}`);
		expect(typeof (await method("complete")).result).toBe("string");
	});

	test("notify sends through the notification service under the extension's name", async () => {
		expect((await method("notify")).result).toBe(true);
	});

	test("settings are the shared /extensions/:id/settings object, and changes are reported", async () => {
		expect((await method("settings", null)).result).toEqual({});
		expect((await method("settings", { level: 2 })).result).toEqual({ level: 2 });
		expect((await call("GET", "/extensions/settings")).json.settings.gen).toEqual({ level: 2 });
		await call("PUT", "/extensions/gen/settings", { settings: { level: 3 } });
		expect((await method("settings", null)).result).toEqual({ level: 3 });
		expect((await method("changed")).result).toBe(2);
	});

	test("a command family lists entries per folder and runs /prefix:name with a note the model never sees", async () => {
		const ext = (await call("GET", "/server-extensions")).json.extensions[0];
		expect(ext.commandFamilies).toEqual([{ prefix: "snip", label: "Snippets" }]);
		const listed = (await call("GET", `/server-extensions/commands?cwd=${encodeURIComponent(ws)}`)).json;
		expect(listed.families).toEqual([{ prefix: "snip", label: "Snippets", extension: "gen", entries: [{ name: "hello", description: "says hi in ws" }] }]);
		const id = (await call("POST", "/sessions", { cwd: ws })).json.id as string;
		upstream.requests.length = 0;
		await call("POST", `/sessions/${id}/messages`, { text: "/snip:hello world" });
		await idle(id);
		const user = ((await call("GET", `/sessions/${id}/messages`)).json.messages as any[])[0].message;
		expect(user.content[0].text).toBe("SNIPPET hello world");
		const note = user.content.find((c: any) => c.text?.startsWith("<pipaya-note>"));
		expect(JSON.parse(note.text.slice("<pipaya-note>".length, note.text.indexOf("</pipaya-note>")))).toEqual({ text: "snippet: hello", collapse: true, data: { name: "hello" }, call: "/snip:hello world" });
		expect(JSON.stringify(upstream.requests.at(-1)!.body)).not.toContain("pipaya-note");
		expect((await call("GET", `/sessions/${id}`)).json.title).toBe("hello");
		await call("POST", `/sessions/${id}/messages`, { text: "noted" });
		await idle(id);
		const second = ((await call("GET", `/sessions/${id}/messages`)).json.messages as any[]).filter((m) => m.role === "user")[1].message;
		expect(JSON.stringify(second)).toContain('{\\"text\\":\\"a note\\",\\"call\\":\\"noted\\"}');
	});
});
