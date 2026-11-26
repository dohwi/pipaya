import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { MASK } from "../src/mcp.ts";
import type { McpOps } from "../src/mcp-tool.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

const SERVER = join(import.meta.dir, "support", "mcp-echo-server.ts");

function makeApp(prefix: string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const cfg: Config = {
		host: "0.0.0.0",
		port: 0,
		dataDir: root,
		dbPath: join(root, "app.db"),
		token: "mcp-tool-test",
		workspaceRoot: root,
		logLevel: "silent",
	};
	return { root, cfg };
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	const first = res.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

describe("built-in mcp tool", () => {
	test("list, add, update (secret preservation & env merge/delete), disable, enable, reload, remove", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-tool-");
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const createTool = () => {
			const defs = app.sessions.toolDefs();
			const ctx = (app.sessions as any).toolContext("preview", undefined, root);
			return defs.mcp!.create(root, [], ctx);
		};
		try {
			const tool = createTool();

			// Empty list
			const empty = await tool.execute("c0", { action: "list" });
			expect(textOf(empty)).toContain("No MCP servers configured");

			// Validation errors
			await expect(tool.execute("e1", { action: "add", name: "  ", transport: "stdio", command: "echo" })).rejects.toThrow("needs `name`");
			await expect(tool.execute("e2", { action: "add", name: "x" })).rejects.toThrow("needs `transport`");
			await expect(tool.execute("e3", { action: "add", name: "bad name", transport: "stdio", command: "echo" })).rejects.toThrow("invalid server name");
			await expect(tool.execute("e4", { action: "add", name: "x", transport: "http", url: "ftp://bad" })).rejects.toThrow("http(s)");
			await expect(tool.execute("e5", { action: "remove", name: "missing" })).rejects.toThrow("not found");
			await expect(tool.execute("e6", { action: "reload", name: "   " })).rejects.toThrow("cannot be empty");

			// Add disabled server (enabled: false does not connect)
			const offRes = await tool.execute("c1", {
				action: "add",
				name: "dormant",
				enabled: false,
				transport: "stdio",
				command: process.execPath,
				args: [SERVER],
			});
			expect(textOf(offRes)).toContain("[off]");
			expect(offRes.details).toMatchObject({ action: "add", name: "dormant", status: "off", tools: 0 });

			// Add enabled server (enabled defaults to true), waits for ready, masks secret value
			const secretVal = "TOP-SECRET-PREFIX:";
			const addRes = await tool.execute("c2", {
				action: "add",
				name: "echo",
				transport: "stdio",
				command: process.execPath,
				args: [SERVER],
				env: { PREFIX: secretVal, EMPTY: "" },
			});
			expect(textOf(addRes)).toContain("[ready]");
			expect(textOf(addRes)).toContain("mcp_echo_echo");
			expect(textOf(addRes)).toContain("env keys: PREFIX, EMPTY");
			expect(textOf(addRes)).not.toContain(secretVal);
			expect(JSON.stringify(addRes.details)).not.toContain(secretVal);

			// Duplicate add (case-insensitive) fails cleanly without modifying existing servers
			await expect(tool.execute("c2-dup", {
				action: "add",
				name: "ECHO",
				transport: "stdio",
				command: process.execPath,
				args: [SERVER],
			})).rejects.toThrow("already exists");

			// Call exposed MCP tool and verify stored secret worked
			const callEcho = async (txt: string) => {
				const remote = app.sessions.toolDefs().mcp_echo_echo!.create(root, [], {});
				return textOf(await remote.execute("r1", { text: txt }));
			};
			expect(await callEcho("one")).toBe(`${secretVal}one`);

			// Update omitting env preserves stored secret; merging new env key preserves stored secret; MASK on unknown key is ignored
			const upd1 = await tool.execute("c3", {
				action: "update",
				name: "ECHO",
				env: { EXTRA: "val", PREFIX: MASK, NO_SUCH: MASK },
			});
			expect(textOf(upd1)).toContain("[ready]");
			expect(textOf(upd1)).toContain("env keys: PREFIX, EMPTY, EXTRA");
			expect(textOf(upd1)).not.toContain("NO_SUCH");
			expect(textOf(upd1)).not.toContain(secretVal);
			expect(await callEcho("two")).toBe(`${secretVal}two`);

			// Update with null deletes one env key while keeping others
			const upd2 = await tool.execute("c4", {
				action: "update",
				name: "echo",
				env: { EXTRA: null },
			});
			expect(textOf(upd2)).toContain("env keys: PREFIX, EMPTY");
			expect(textOf(upd2)).not.toContain("EXTRA");
			expect(await callEcho("three")).toBe(`${secretVal}three`);

			// allowTools: [] exposes 0 tools; allowTools: null clears filter
			const filtered = await tool.execute("c5", { action: "update", name: "echo", allowTools: [] });
			expect(textOf(filtered)).toContain("tools: none");
			expect(app.sessions.toolDefs().mcp_echo_echo).toBeUndefined();

			const cleared = await tool.execute("c6", { action: "update", name: "echo", allowTools: null });
			expect(textOf(cleared)).toContain("mcp_echo_echo");
			expect(app.sessions.toolDefs().mcp_echo_echo).toBeDefined();

			// Disable / enable / reload
			const dis = await tool.execute("c7", { action: "disable", name: "echo" });
			expect(textOf(dis)).toContain("[off]");
			expect(app.sessions.toolDefs().mcp_echo_echo).toBeUndefined();

			const ena = await tool.execute("c8", { action: "enable", name: "echo" });
			expect(textOf(ena)).toContain("[ready]");
			expect(app.sessions.toolDefs().mcp_echo_echo).toBeDefined();

			const rel = await tool.execute("c9", { action: "reload", name: "echo" });
			expect(textOf(rel)).toContain("[ready]");

			const relAll = await tool.execute("c10", { action: "reload" });
			expect(textOf(relAll)).toContain("Reloaded MCP servers:");

			// List shows both servers
			const listed = await tool.execute("c11", { action: "list" });
			expect(textOf(listed)).toContain("2 MCP server(s)");
			expect(textOf(listed)).toContain("dormant [off]");
			expect(textOf(listed)).toContain("echo [ready]");
			expect(textOf(listed)).not.toContain(secretVal);

			// Remove
			const rem = await tool.execute("c12", { action: "remove", name: "echo" });
			expect(textOf(rem)).toContain('Removed MCP server "echo"');
			expect(app.sessions.toolDefs().mcp_echo_echo).toBeUndefined();
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("captures stdio stderr tail on failure, redacts secrets, and shows PATH hint on ENOENT", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-err-");
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const failScript = join(root, "fail-mcp.ts");
		writeFileSync(
			failScript,
			'console.error("noise ".repeat(250) + "fatal: invalid token " + process.env.API_KEY + " missing dependency foo-bar"); process.exit(1);\n',
		);
		const createTool = () => {
			const ctx = (app.sessions as any).toolContext("preview", undefined, root);
			return app.sessions.toolDefs().mcp!.create(root, [], ctx);
		};
		try {
			const tool = createTool();
			const secret = "sk-live-very-secret-9999";

			const failRes = await tool.execute("f1", {
				action: "add",
				name: "broken",
				transport: "stdio",
				command: process.execPath,
				args: [failScript],
				env: { API_KEY: secret },
			});
			expect(textOf(failRes)).toContain("[error]");
			expect(textOf(failRes)).toContain("missing dependency foo-bar");
			expect(textOf(failRes)).toContain(MASK);
			expect(textOf(failRes)).not.toContain(secret);

			const enoentRes = await tool.execute("f2", {
				action: "add",
				name: "missing_bin",
				transport: "stdio",
				command: "/definitely/no/such/binary-pipaya-test",
			});
			expect(textOf(enoentRes)).toContain("[error]");
			expect(textOf(enoentRes)).toContain("hint: the executable must be installed");
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("waitFor honors abort signal and drop mid-connect without hanging", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-abort-");
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const hangScript = join(root, "hang-mcp.ts");
		writeFileSync(hangScript, "setInterval(() => {}, 60_000);\n");
		const ops = (app.sessions as any).toolContext("preview", undefined, root).mcp as McpOps;
		try {
			ops.add({ name: "slow", enabled: true, transport: "stdio", command: process.execPath, args: [hangScript] });

			// Aborted signal returns promptly
			const ac = new AbortController();
			setTimeout(() => ac.abort(), 50);
			const t0 = Date.now();
			const aborted = await ops.waitFor("slow", 10_000, ac.signal);
			expect(Date.now() - t0).toBeLessThan(2000);
			expect(aborted.servers[0]!.status).toBe("connecting");

			// Removing mid-connect resolves any waiter promptly
			const t1 = Date.now();
			const waiter = ops.waitFor("slow", 10_000);
			setTimeout(() => ops.remove("slow"), 50);
			const afterRemove = await waiter;
			expect(Date.now() - t1).toBeLessThan(2000);
			expect(afterRemove.servers).toEqual([]);
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("session uses mcp tool to add a server, toggles off via configuration, and strips mcp from subagents", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-session-");
		const upstream = startEchoUpstream();
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

			// Toggleable tools include mcp
			const cfgInfo = (await api("GET", "/configuration")).json;
			expect(cfgInfo.tools.toggleable).toContain("mcp");

			const id = (await api("POST", "/sessions", { cwd: root })).json.id as string;
			expect((await api("GET", `/sessions/${id}/context`)).json.toolSpecs.map((t: any) => t.name)).toContain("mcp");

			// Agent calls mcp tool to register echo server
			const addPayload = JSON.stringify({
				action: "add",
				name: "echo",
				transport: "stdio",
				command: process.execPath,
				args: [SERVER],
				env: { PREFIX: "live:" },
			});
			await api("POST", `/sessions/${id}/messages`, { text: `!mcp ${addPayload}` });
			await idle(id);
			const msgs1 = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
			expect(msgs1).toContain("mcp_echo_echo");
			expect(msgs1).toContain("New MCP tools are available from the next turn");

			// Immediately usable on the next message in the same session
			await api("POST", `/sessions/${id}/messages`, { text: '!mcp_echo_echo {"text":"works"}' });
			await idle(id);
			const msgs2 = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
			expect(msgs2).toContain("live:works");

			// Mid-run retargetTools: onChange marks live sessions dirty, rebuilds tools only when names change
			const rec = (app.sessions as any).store.get(id);
			const live = (app.sessions as any).ensureLive(rec);
			expect(live.agent.state.tools.map((t: any) => t.name)).toContain("mcp_echo_echo");
			// No-op when nothing changed
			expect((app.sessions as any).retargetTools(id)).toBeUndefined();
			// Adding a second MCP server via REST marks live dirty; once ready, retargetTools rebuilds with new tool
			await api("POST", "/mcp", { name: "echo2", enabled: true, transport: "stdio", command: process.execPath, args: [SERVER] });
			const ops = (app.sessions as any).toolContext("preview", undefined, root).mcp as McpOps;
			await ops.waitFor("echo2", 10_000);
			const rebuilt = (app.sessions as any).retargetTools(id) as Array<{ name: string }> | undefined;
			expect(rebuilt?.map((t) => t.name)).toContain("mcp_echo2_echo");
			// Calling retargetTools again when nothing changed returns undefined (no prompt-cache churn)
			expect((app.sessions as any).retargetTools(id)).toBeUndefined();

			// Subagent explicitly listing `mcp` and `mcp_echo_echo`: gets remote `mcp_echo_echo`, never management `mcp`
			const roleDir = join(root, ".agents", "subagents");
			mkdirSync(roleDir, { recursive: true });
			writeFileSync(
				join(roleDir, "checker.md"),
				"---\nname: checker\ndescription: test\ntools: mcp, mcp_echo_echo, read\n---\nCheck tools.\n",
			);
			await api("POST", `/sessions/${id}/messages`, { text: '!delegate {"role":"checker","task":"!mcp_echo_echo {\\"text\\":\\"sub\\"}"}' });
			await idle(id);
			const msgs3 = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
			expect(msgs3).toContain("live:sub");

			await api("POST", `/sessions/${id}/messages`, { text: '!delegate {"role":"checker","task":"!mcp {\\"action\\":\\"list\\"}"}' });
			await idle(id);
			const msgs4 = (await api("GET", `/sessions/${id}/messages`)).json.messages;
			const lastText = JSON.stringify(msgs4.slice(-2));
			expect(lastText).toContain("Tool mcp not found");
			expect(lastText).not.toContain("MCP server(s)");

			// Disabling mcp tool marks it disabled in context toolSpecs and withholds it from the agent
			expect((await api("PUT", "/configuration/tools", { disabled: ["mcp"] })).status).toBe(200);
			const id2 = (await api("POST", "/sessions", { cwd: root })).json.id as string;
			const specs2 = (await api("GET", `/sessions/${id2}/context`)).json.toolSpecs as { name: string; enabled: boolean }[];
			expect(specs2.find((t) => t.name === "mcp")?.enabled).toBe(false);
			const enabled2 = (app.sessions as any).sessionTools(id2, ["read"], root).map((t: any) => t.name);
			expect(enabled2).not.toContain("mcp");
		} finally {
			await app.close();
			upstream.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
