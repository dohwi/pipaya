import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { MASK } from "../src/mcp.ts";
import { startMcpHttp } from "./support/mcp-http-server.ts";

const SERVER = join(import.meta.dir, "support", "mcp-echo-server.ts");

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
	for (let i = 0; i < 100; i++) {
		const v = await fn();
		if (ok(v)) return v;
		await Bun.sleep(100);
	}
	return fn();
}

describe("MCP servers", () => {
	test("connect over stdio, list tools, call them, keep secrets masked, drop on disable", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-mcp-")));
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: root, dbPath: join(root, "app.db"), token: "mcp-test", workspaceRoot: root, logLevel: "silent" };
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false });
		const api = async (method: "GET" | "PUT" | "POST", url: string, payload?: object, authorized = true) => {
			const res = await app.server.inject({ method, url, payload, headers: authorized ? { authorization: `Bearer ${cfg.token}` } : {} });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const echo = { name: "echo", enabled: true, transport: "stdio", command: process.execPath, args: [SERVER], env: { PREFIX: "hi:" } };
		try {
			expect((await api("GET", "/mcp", undefined, false)).status).toBe(401);
			expect((await api("GET", "/mcp")).json).toMatchObject({ servers: [], ready: 0, tools: 0 });

			expect((await api("PUT", "/mcp", { servers: [{ ...echo, name: "bad name" }] })).status).toBe(400);
			expect((await api("PUT", "/mcp", { servers: [{ ...echo, command: " " }] })).status).toBe(400);
			expect((await api("PUT", "/mcp", { servers: [{ name: "w", enabled: true, transport: "http", url: "ftp://x" }] })).status).toBe(400);
			expect((await api("PUT", "/mcp", { servers: [echo, echo] })).status).toBe(400);

			const saved = await api("PUT", "/mcp", { servers: [echo] });
			expect(saved.status).toBe(200);
			expect(saved.json.servers[0].env).toEqual({ PREFIX: MASK });

			const ready = await until(async () => (await api("GET", "/mcp")).json, (j) => j.ready === 1);
			expect(ready).toMatchObject({ ready: 1, tools: 1 });
			expect(ready.servers[0].tools[0]).toMatchObject({ name: "mcp_echo_echo", tool: "echo" });

			// The tool reaches sessions and runs.
			const defs = (app.sessions as any).toolDefs();
			const tool = defs.mcp_echo_echo.create("/", [], {});
			const out = await tool.execute("c1", { text: "yo" }, undefined);
			expect(out.content[0].text).toBe("hi:yo");

			// Sending the masked value back keeps the stored secret.
			await api("PUT", "/mcp", { servers: [{ ...echo, env: { PREFIX: MASK } }] });
			await until(async () => (await api("GET", "/mcp")).json, (j) => j.ready === 1);
			const again = (app.sessions as any).toolDefs().mcp_echo_echo.create("/", [], {});
			expect((await again.execute("c2", { text: "x" }, undefined)).content[0].text).toBe("hi:x");

			// A server that cannot start shows an error and no tools.
			const broken = await api("PUT", "/mcp", { servers: [{ ...echo, command: "/no/such/program" }] });
			expect(broken.status).toBe(200);
			const failed = await until(async () => (await api("GET", "/mcp")).json, (j) => j.servers[0].status === "error");
			expect(failed).toMatchObject({ ready: 0, tools: 0 });
			expect(failed.servers[0].error).toBeTruthy();

			// Switched off: no connection, no tools.
			const off = await api("PUT", "/mcp", { servers: [{ ...echo, enabled: false }] });
			expect(off.json).toMatchObject({ ready: 0, tools: 0 });
			expect(off.json.servers[0].status).toBe("off");
			expect((app.sessions as any).toolDefs().mcp_echo_echo).toBeUndefined();
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("MCP tools in a real conversation", () => {
	test("the model calls an MCP tool through a session and the result comes back; a disconnected server's tool is gone", async () => {
		const { ECHO_MODEL, echoProviderBody, startEchoUpstream } = await import("./support/openai-upstream.ts");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-mcp-e2e-")));
		const upstream = startEchoUpstream();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: root, dbPath: join(root, "app.db"), token: "mcp-e2e", workspaceRoot: root, logLevel: "silent" };
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const api = async (method: "GET" | "PUT" | "POST", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const idle = async (id: string) => {
			for (let i = 0; i < 200; i++) {
				if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
				await Bun.sleep(25);
			}
			throw new Error("never idle");
		};
		try {
			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
			await api("PUT", "/mcp", { servers: [{ name: "echo", enabled: true, transport: "stdio", command: process.execPath, args: [SERVER], env: { PREFIX: "mcp says: " } }] });
			await until(async () => (await api("GET", "/mcp")).json, (j) => j.ready === 1);

			const id = (await api("POST", "/sessions", {})).json.id as string;
			// What the model is offered.
			const ctx = (await api("GET", `/sessions/${id}/context`)).json;
			expect(ctx.toolSpecs.map((t: any) => t.name)).toContain("mcp_echo_echo");

			await api("POST", `/sessions/${id}/messages`, { text: '!mcp_echo_echo {"text":"ping"}' });
			await idle(id);
			const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
			const result = JSON.stringify(msgs);
			expect(result).toContain("mcp says: ping");
			expect(result).toContain("Tool mcp_echo_echo finished");

			// Switched off: the next session no longer gets the tool.
			await api("PUT", "/mcp", { servers: [{ name: "echo", enabled: false, transport: "stdio", command: process.execPath, args: [SERVER] }] });
			const id2 = (await api("POST", "/sessions", {})).json.id as string;
			const ctx2 = (await api("GET", `/sessions/${id2}/context`)).json;
			expect(ctx2.toolSpecs.map((t: any) => t.name)).not.toContain("mcp_echo_echo");
		} finally {
			await app.close();
			upstream.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("MCP over HTTP", () => {
	test("connects with headers, runs a tool, and shows an error when the header is wrong", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-mcp-http-")));
		const remote = startMcpHttp();
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: root, dbPath: join(root, "app.db"), token: "mcp-http", workspaceRoot: root, logLevel: "silent" };
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const api = async (method: "GET" | "PUT", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const srv = (key: string) => ({ name: "remote", enabled: true, transport: "http", url: remote.url, headers: { "x-key": key } });
		try {
			await api("PUT", "/mcp", { servers: [srv("wrong")] });
			const bad = await until(async () => (await api("GET", "/mcp")).json, (j) => j.servers[0].status === "error");
			expect(bad.servers[0].error).toBeTruthy();
			expect(bad.servers[0].headers).toEqual({ "x-key": MASK });

			await api("PUT", "/mcp", { servers: [srv("secret")] });
			const ok = await until(async () => (await api("GET", "/mcp")).json, (j) => j.ready === 1);
			expect(ok.servers[0].tools[0]).toMatchObject({ name: "mcp_remote_shout", tool: "shout" });
			const tool = (app.sessions as any).toolDefs().mcp_remote_shout.create("/", [], {});
			expect((await tool.execute("c", { text: "hello" }, undefined)).content[0].text).toBe("HELLO");
		} finally {
			await app.close();
			remote.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("MCP single-server REST routes", () => {
	test("POST /mcp, PATCH /mcp/:name, DELETE /mcp/:name preserve other servers and stored secrets", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-mcp-crud-")));
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: root, dbPath: join(root, "app.db"), token: "mcp-crud", workspaceRoot: root, logLevel: "silent" };
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const api = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const echo = { name: "echo", enabled: true, transport: "stdio", command: process.execPath, args: [SERVER], env: { PREFIX: "crud:" } };
		const other = { name: "other", enabled: false, transport: "stdio", command: process.execPath, args: [SERVER] };
		try {
			const created = await api("POST", "/mcp", echo);
			expect(created.status).toBe(201);
			expect(created.json.servers).toHaveLength(1);
			expect(created.json.servers[0].env).toEqual({ PREFIX: MASK });

			// Duplicate name returns 409
			expect((await api("POST", "/mcp", { ...echo, name: "ECHO" })).status).toBe(409);

			// Add a second server without touching the first
			expect((await api("POST", "/mcp", other)).status).toBe(201);
			await until(async () => (await api("GET", "/mcp")).json, (j) => j.ready === 1);

			// PATCH merges env and preserves untouched PREFIX secret
			const patched = await api("PATCH", "/mcp/echo", { env: { EXTRA: "1" } });
			expect(patched.status).toBe(200);
			expect(patched.json.servers.find((s: any) => s.name === "echo").env).toEqual({ PREFIX: MASK, EXTRA: MASK });
			await until(async () => (await api("GET", "/mcp")).json, (j) => j.ready === 1);
			const tool = (app.sessions as any).toolDefs().mcp_echo_echo.create("/", [], {});
			expect((await tool.execute("c1", { text: "ok" }, undefined)).content[0].text).toBe("crud:ok");

			// PATCH unknown returns 404; invalid transport switch without url returns 400
			expect((await api("PATCH", "/mcp/missing", { enabled: false })).status).toBe(404);
			expect((await api("PATCH", "/mcp/other", { transport: "http" })).status).toBe(400);

			// PATCH switching transport stdio -> http strips stdio fields and merges headers; http -> stdio strips http fields
			const toHttp = await api("PATCH", "/mcp/other", { transport: "http", url: "https://example.com/mcp", headers: { authorization: "Bearer s1" } });
			expect(toHttp.status).toBe(200);
			const httpSrv = toHttp.json.servers.find((s: any) => s.name === "other");
			expect(httpSrv).toMatchObject({ transport: "http", url: "https://example.com/mcp", headers: { authorization: MASK } });
			expect(httpSrv.command).toBeUndefined();
			const mergedHdr = await api("PATCH", "/mcp/other", { headers: { "x-extra": "2" } });
			expect(mergedHdr.json.servers.find((s: any) => s.name === "other").headers).toEqual({ authorization: MASK, "x-extra": MASK });
			const backStdio = await api("PATCH", "/mcp/other", { transport: "stdio", command: process.execPath, args: [SERVER] });
			expect(backStdio.status).toBe(200);
			const stdioSrv = backStdio.json.servers.find((s: any) => s.name === "other");
			expect(stdioSrv.url).toBeUndefined();
			expect(stdioSrv.headers).toBeUndefined();

			// DELETE removes only the named server (case-insensitive); second DELETE returns 404
			const del = await api("DELETE", "/mcp/ECHO");
			expect(del.status).toBe(200);
			expect(del.json.servers.map((s: any) => s.name)).toEqual(["other"]);
			expect((await api("DELETE", "/mcp/echo")).status).toBe(404);

			// MAX_SERVERS (50) cap enforced on POST /mcp
			for (let i = 0; i < 49; i++) {
				expect((await api("POST", "/mcp", { name: `s_${i}`, enabled: false, transport: "stdio", command: "echo" })).status).toBe(201);
			}
			expect((await api("POST", "/mcp", { name: "s_overflow", enabled: false, transport: "stdio", command: "echo" })).status).toBe(400);
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
