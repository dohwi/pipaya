import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { MCP_DEFERRED_THRESHOLD, MCP_SEARCH_TOOL, McpManager } from "../src/mcp.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream } from "./support/openai-upstream.ts";

/** Writes a fast stdio MCP server script that registers `count` tools named `tool_01..tool_NN` (plus optional custom suffix). */
function writeMultiToolServer(dir: string): string {
	const script = join(dir, "multi-mcp-server.ts");
	writeFileSync(
		script,
		`import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.MCP_START_LOG) {
	appendFileSync(process.env.MCP_START_LOG, \`\${process.pid}\\n\`);
}

const count = Number(process.env.TOOL_COUNT ?? "1");
const label = process.env.SERVER_LABEL ?? "multi";
const server = new McpServer({ name: label, version: "1.0.0" });

for (let i = 1; i <= count; i++) {
	const num = String(i).padStart(2, "0");
	const toolName = \`tool_\${num}\`;
	const kind = i % 2 === 0 ? "writer" : "reader";
	server.registerTool(
		toolName,
		{
			description: \`\${label} \${kind} operation number \${num}\\nSecond line detail for \${toolName}\`,
			inputSchema: { text: z.string().describe("Input payload") },
		},
		async ({ text }) => ({
			content: [{ type: "text", text: \`\${label}:\${toolName}:\${text}\` }],
		}),
	);
}

await server.connect(new StdioServerTransport());
`,
	);
	return script;
}

function makeApp(prefix: string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const cfg: Config = {
		host: "0.0.0.0",
		port: 0,
		dataDir: root,
		dbPath: join(root, "app.db"),
		token: "mcp-search-test",
		workspaceRoot: root,
		logLevel: "silent",
	};
	return { root, cfg };
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	const first = res.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

/** Minimal scripted OpenAI-compatible SSE upstream that records every request's tool declarations and runs a sequence of steps. */
function startScriptedUpstream(steps: Array<{ text: string; tool?: { name: string; args: Record<string, unknown> } }>) {
	const requests: Array<{ tools: Array<{ name: string; parameters?: unknown }>; messages: any[] }> = [];
	let stepIdx = 0;
	let callCounter = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/v1/models") {
				return Response.json({ object: "list", data: [{ id: ECHO_MODEL.id, object: "model" }] });
			}
			if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
				const body = (await req.json()) as any;
				const tools = Array.isArray(body.tools)
					? body.tools.map((t: any) => ({ name: t.function?.name ?? t.name, parameters: t.function?.parameters }))
					: [];
				requests.push({ tools, messages: body.messages ?? [] });
				const step = steps[stepIdx++] ?? { text: "done" };
				const callId = `call_${++callCounter}`;
				const base = { id: `chatcmpl-${callCounter}`, object: "chat.completion.chunk", created: 1, model: ECHO_MODEL.id };
				const frames: object[] = [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
				];
				if (step.tool) {
					frames.push({
						...base,
						choices: [{
							index: 0,
							delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] },
							finish_reason: null,
						}],
					});
					frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
				} else {
					frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
				}
				const sse = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		stop: () => server.stop(true),
	};
}

describe("MCP deferred tool loading (mcp_search)", () => {
	test("below or at threshold exposes MCP tools directly without mcp_search; above threshold switches to mcp_search", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-threshold-");
		const serverScript = writeMultiToolServer(root);
		const upstream = startEchoUpstream();
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const api = async (method: "GET" | "PUT" | "POST", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		try {
			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);

			// 3 tools (well below threshold) -> direct exposure, no mcp_search
			await api("PUT", "/mcp", {
				servers: [{ name: "small", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "3", SERVER_LABEL: "small" } }],
			});
			await (app.sessions as any).toolContext("preview", undefined, root).mcp.waitFor("small", 15_000);

			const id = (await api("POST", "/sessions", { cwd: root })).json.id as string;
			const specsSmall = ((await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string }[]).map((t) => t.name);
			expect(specsSmall).toContain("mcp_small_tool_01");
			expect(specsSmall).toContain("mcp_small_tool_03");
			expect(specsSmall).not.toContain(MCP_SEARCH_TOOL);

			// Exact threshold (15 tools) -> still direct exposure, no mcp_search
			await api("PUT", "/mcp", {
				servers: [{ name: "exact", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: String(MCP_DEFERRED_THRESHOLD), SERVER_LABEL: "exact" } }],
			});
			await (app.sessions as any).toolContext("preview", undefined, root).mcp.waitFor("exact", 15_000);
			const specsExact = ((await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string }[]).map((t) => t.name);
			expect(specsExact).toContain("mcp_exact_tool_01");
			expect(specsExact).toContain(`mcp_exact_tool_${String(MCP_DEFERRED_THRESHOLD).padStart(2, "0")}`);
			expect(specsExact).not.toContain(MCP_SEARCH_TOOL);

			// Above threshold (20 tools across 2 servers) -> deferred mode: only mcp_search exposed, no raw MCP tools
			await api("PUT", "/mcp", {
				servers: [
					{ name: "alpha", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "12", SERVER_LABEL: "alpha" } },
					{ name: "beta", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "8", SERVER_LABEL: "beta" } },
				],
			});
			await (app.sessions as any).toolContext("preview", undefined, root).mcp.waitFor(undefined, 15_000);
			const specsDeferred = (await api("GET", `/sessions/${id}/context`)).json.toolSpecs as { name: string; description: string }[];
			const namesDeferred = specsDeferred.map((t) => t.name);
			expect(namesDeferred).toContain(MCP_SEARCH_TOOL);
			expect(namesDeferred.filter((n) => n.startsWith("mcp_alpha_") || n.startsWith("mcp_beta_"))).toEqual([]);
			const searchSpec = specsDeferred.find((t) => t.name === MCP_SEARCH_TOOL)!;
			expect(searchSpec.description).toContain("alpha (12)");
			expect(searchSpec.description).toContain("beta (8)");
			expect(searchSpec.description).toContain("20 active tools");
		} finally {
			await app.close();
			upstream.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("mcp_search search accuracy (keyword, server filter, case-insensitivity, empty query browse, load edge cases)", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-mcp-search-unit-")));
		const serverScript = writeMultiToolServer(root);
		const db = openDb(join(root, "app.db"));
		const mcp = new McpManager(db);
		try {
			mcp.set([
				{ name: "alpha", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "12", SERVER_LABEL: "alpha" } },
				{ name: "beta", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "8", SERVER_LABEL: "beta" } },
			]);
			await mcp.waitFor(undefined, 15_000);
			expect(mcp.isDeferred()).toBe(true);

			const loadedSet = new Set<string>();
			const searchTool = mcp.searchToolDef({
				getLoaded: () => loadedSet,
				load: (names) => {
					const loaded: string[] = [];
					const alreadyLoaded: string[] = [];
					for (const n of names) {
						if (loadedSet.has(n)) alreadyLoaded.push(n);
						else {
							loadedSet.add(n);
							loaded.push(n);
						}
					}
					return { loaded, alreadyLoaded };
				},
			}).create(root);

			// Empty query -> compact summary of all 20 tools grouped by server
			const browse = await searchTool.execute("s1", {});
			const browseText = textOf(browse);
			expect(browseText).toContain("20 matching / 20 total");
			expect(browseText).toContain("[alpha]");
			expect(browseText).toContain("[beta]");
			expect(browseText).toContain("mcp_alpha_tool_01");
			expect(browseText).toContain("mcp_beta_tool_08");
			// Multi-line descriptions are compacted to first line only
			expect(browseText).not.toContain("Second line detail");

			// Empty string query also returns full summary
			const emptyQ = await searchTool.execute("s2", { query: "   " });
			expect(emptyQ.details).toMatchObject({ matched: 20, totalTools: 20 });

			// Case-insensitive keyword search matching description + server
			const kw = await searchTool.execute("s3", { query: "BETA WRITER" });
			const kwText = textOf(kw);
			expect(kw.details).toMatchObject({ matched: 4 }); // beta has 8 tools, even numbers (02,04,06,08) are writers
			expect(kwText).toContain("mcp_beta_tool_02");
			expect(kwText).not.toContain("mcp_beta_tool_01");
			expect(kwText).not.toContain("mcp_alpha_");

			// Server filter (case-insensitive) + limit
			const srv = await searchTool.execute("s4", { server: "ALPHA", limit: 3 });
			expect(srv.details).toMatchObject({ matched: 12 });
			expect(textOf(srv)).toContain("Showing 3 of 12 matching tools");

			// Unknown server filter -> helpful message with available servers
			const unknownSrv = await searchTool.execute("s5", { server: "nope" });
			expect(textOf(unknownSrv)).toContain('No ready MCP server named "nope"');
			expect(textOf(unknownSrv)).toContain("alpha (12)");

			// Empty load array -> safe no-op
			const emptyLoad = await searchTool.execute("s6", { load: [] });
			expect(emptyLoad.details).toMatchObject({ loaded: [], alreadyLoaded: [], notFound: [] });
			expect(textOf(emptyLoad)).toContain("empty load list");

			// Load with duplicates, case-insensitivity, and unknown names
			const mixedLoad = await searchTool.execute("s7", {
				load: ["MCP_ALPHA_TOOL_03", "mcp_alpha_tool_03", "mcp_does_not_exist", "  "],
			});
			expect(mixedLoad.details).toMatchObject({
				loaded: ["mcp_alpha_tool_03"],
				alreadyLoaded: [],
				notFound: ["mcp_does_not_exist", "  "],
			});

			// Re-loading the same tool is idempotent
			const reloadSame = await searchTool.execute("s8", { load: ["mcp_alpha_tool_03"] });
			expect(reloadSame.details).toMatchObject({ loaded: [], alreadyLoaded: ["mcp_alpha_tool_03"], notFound: [] });

			// Search now marks mcp_alpha_tool_03 as [loaded]
			const afterSearch = await searchTool.execute("s9", { query: "tool_03", server: "alpha" });
			expect(textOf(afterSearch)).toContain("mcp_alpha_tool_03 [alpha]:");
			expect(textOf(afterSearch)).toContain("[loaded]");

			// loadServer loads all tools of a server in deterministic catalog order; unknown loadServer goes to notFound
			const loadBeta = await searchTool.execute("s10", { loadServer: "BETA" });
			expect((loadBeta.details as any).loaded).toHaveLength(8);
			expect((loadBeta.details as any).loaded[0]).toBe("mcp_beta_tool_01");
			expect((loadBeta.details as any).loaded[7]).toBe("mcp_beta_tool_08");

			// Non-integer limit (NaN) falls back to default, and non-string entries in load do not throw
			const nanLimit = await searchTool.execute("s11b", { query: "alpha", limit: Number.NaN as any });
			expect((nanLimit.details as any).matched).toBe(12);
			const nonStringLoad = await searchTool.execute("s11c", { load: [123 as any, "mcp_alpha_tool_04"] });
			expect(nonStringLoad.details).toMatchObject({ loaded: ["mcp_alpha_tool_04"], notFound: ["123"] });

			const loadBadServer = await searchTool.execute("s11", { loadServer: "missing" });
			expect(loadBadServer.details).toMatchObject({ loaded: [], alreadyLoaded: [], notFound: ["server:missing"] });
		} finally {
			await mcp.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("same-run load makes MCP tool callable on the very next step while preserving lazy stdio startup", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-deferred-e2e-");
		const serverScript = writeMultiToolServer(root);
		const startLog = join(root, "starts.log");

		// Step 1: Prime SQLite mcp_tool_cache with a 20-tool stdio server, then close so the next app starts lazily.
		{
			const primeApp = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
			try {
				await primeApp.server.inject({
					method: "PUT",
					url: "/mcp",
					headers: { authorization: `Bearer ${cfg.token}` },
					payload: {
						servers: [{
							name: "big",
							enabled: true,
							transport: "stdio",
							command: process.execPath,
							args: [serverScript],
							env: { TOOL_COUNT: "20", SERVER_LABEL: "big", MCP_START_LOG: startLog },
						}],
					},
				});
				await (primeApp.sessions as any).toolContext("preview", undefined, root).mcp.waitFor("big", 15_000);
			} finally {
				await primeApp.close();
			}
		}
		// Clear start log so we verify zero spawns happen on boot or during mcp_search!
		rmSync(startLog, { force: true });

		// Scripted 3-step single run:
		//   Step 1: call mcp_search to search & load mcp_big_tool_03
		//   Step 2 (SAME RUN): call mcp_big_tool_03 directly
		//   Step 3: wrap up
		const upstream = startScriptedUpstream([
			{ text: "Searching and loading tool_03…", tool: { name: MCP_SEARCH_TOOL, args: { query: "tool_03", load: ["mcp_big_tool_03"] } } },
			{ text: "Calling mcp_big_tool_03…", tool: { name: "mcp_big_tool_03", args: { text: "deferred-ok" } } },
			{ text: "All done!" },
		]);

		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const api = async (method: "GET" | "PUT" | "POST", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		const idle = async (id: string) => {
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
				await Bun.sleep(25);
			}
			throw new Error("never idle");
		};
		try {
			// Booting from cache must not spawn stdio child process
			expect(existsSync(startLog)).toBe(false);

			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);

			const id = (await api("POST", "/sessions", { cwd: root })).json.id as string;
			await api("POST", `/sessions/${id}/messages`, { text: "Please run tool 03" });
			await idle(id);

			expect(upstream.requests).toHaveLength(3);

			// Request 1: only mcp_search exposed, none of the 20 raw MCP tools
			const req1Tools = upstream.requests[0]!.tools.map((t) => t.name);
			expect(req1Tools).toContain(MCP_SEARCH_TOOL);
			expect(req1Tools.filter((n) => n.startsWith("mcp_big_"))).toEqual([]);

			// Request 2 (same run, immediately after mcp_search): mcp_big_tool_03 is now exposed with full schema!
			const req2Tools = upstream.requests[1]!.tools;
			const req2Names = req2Tools.map((t) => t.name);
			expect(req2Names).toContain(MCP_SEARCH_TOOL);
			expect(req2Names).toContain("mcp_big_tool_03");
			expect(req2Names.filter((n) => n.startsWith("mcp_big_"))).toEqual(["mcp_big_tool_03"]);
			const loadedSchema = req2Tools.find((t) => t.name === "mcp_big_tool_03")?.parameters as any;
			expect(loadedSchema?.properties?.text?.type).toBe("string");

			// Request 3: tool_03 executed and returned real output from the lazily-started stdio process!
			const msgs = JSON.stringify((await api("GET", `/sessions/${id}/messages`)).json.messages);
			expect(msgs).toContain("big:tool_03:deferred-ok");

			// Stdio child process spawned exactly once (on first callTool in step 2, NOT on boot or mcp_search)
			expect(existsSync(startLog)).toBe(true);
			const pids = readFileSync(startLog, "utf8").trim().split("\n").filter(Boolean);
			expect(pids).toHaveLength(1);

			// Forking preserves loaded MCP tools on the forked session
			const forkRes = await api("POST", `/sessions/${id}/fork`, {});
			expect(forkRes.status).toBe(201);
			const forkedId = forkRes.json.id as string;
			const forkSpecs = ((await api("GET", `/sessions/${forkedId}/context`)).json.toolSpecs as { name: string }[]).map((t) => t.name);
			expect(forkSpecs).toContain(MCP_SEARCH_TOOL);
			expect(forkSpecs).toContain("mcp_big_tool_03");
		} finally {
			await app.close();
			upstream.stop();
		}

		// Server restart on the same SQLite DB hydrates loaded MCP tools from persisted mcp_search results
		const app2 = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		try {
			const sessionsRes = await app2.server.inject({
				method: "GET",
				url: "/sessions",
				headers: { authorization: `Bearer ${cfg.token}` },
			});
			const sessionsList = sessionsRes.json().sessions as Array<{ id: string }>;
			expect(sessionsList.length).toBeGreaterThanOrEqual(2);
			for (const s of sessionsList) {
				const ctxRes = await app2.server.inject({
					method: "GET",
					url: `/sessions/${s.id}/context`,
					headers: { authorization: `Bearer ${cfg.token}` },
				});
				const names = (ctxRes.json().toolSpecs as { name: string }[]).map((t) => t.name);
				expect(names).toContain(MCP_SEARCH_TOOL);
				expect(names).toContain("mcp_big_tool_03");
			}
		} finally {
			await app2.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("session isolation, stable load order, stale cleanup on disable/deny/remove, and session delete cleanup", async () => {
		const { root, cfg } = makeApp("pipaya-mcp-isolation-");
		const serverScript = writeMultiToolServer(root);
		const upstream = startEchoUpstream();
		const app = await buildApp(cfg, { strictResponses: true, home: root, builtinSkills: false, extensionDirs: [] });
		const api = async (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => {
			const res = await app.server.inject({ method, url, payload, headers: { authorization: `Bearer ${cfg.token}` } });
			return { status: res.statusCode, json: res.body ? res.json() : undefined };
		};
		try {
			expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
			expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);

			await api("PUT", "/mcp", {
				servers: [
					{ name: "alpha", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "10", SERVER_LABEL: "alpha" } },
					{ name: "beta", enabled: true, transport: "stdio", command: process.execPath, args: [serverScript], env: { TOOL_COUNT: "10", SERVER_LABEL: "beta" } },
				],
			});
			await (app.sessions as any).toolContext("preview", undefined, root).mcp.waitFor(undefined, 15_000);

			const idA = (await api("POST", "/sessions", { cwd: root })).json.id as string;
			const idB = (await api("POST", "/sessions", { cwd: root })).json.id as string;

			const recA = (app.sessions as any).store.get(idA);
			const liveA = (app.sessions as any).ensureLive(recA);
			const recB = (app.sessions as any).store.get(idB);
			const liveB = (app.sessions as any).ensureLive(recB);

			// Load mcp_beta_tool_05 then mcp_alpha_tool_02 in session A via its mcp_search tool
			const searchA = liveA.agent.state.tools.find((t: any) => t.name === MCP_SEARCH_TOOL);
			expect(searchA).toBeDefined();
			await searchA.execute("c1", { load: ["mcp_beta_tool_05"] });
			const rebuilt1 = (app.sessions as any).retargetTools(idA) as Array<{ name: string }> | undefined;
			expect(rebuilt1?.map((t) => t.name)).toContain("mcp_beta_tool_05");

			// Reloading the same tool does not dirty tools (no prompt-cache churn)
			await searchA.execute("c2", { load: ["mcp_beta_tool_05"] });
			expect((app.sessions as any).retargetTools(idA)).toBeUndefined();

			// Loading a second tool appends AFTER the first (preserving prompt-cache prefix order)
			await searchA.execute("c3", { load: ["mcp_alpha_tool_02"] });
			const rebuilt2 = (app.sessions as any).retargetTools(idA) as Array<{ name: string }> | undefined;
			const namesA = rebuilt2!.map((t) => t.name);
			expect(namesA.indexOf(MCP_SEARCH_TOOL)).toBeLessThan(namesA.indexOf("mcp_beta_tool_05"));
			expect(namesA.indexOf("mcp_beta_tool_05")).toBeLessThan(namesA.indexOf("mcp_alpha_tool_02"));

			// Session B is completely isolated: neither tool leaked into B
			const specsB = ((await api("GET", `/sessions/${idB}/context`)).json.toolSpecs as { name: string }[]).map((t) => t.name);
			expect(specsB).toContain(MCP_SEARCH_TOOL);
			expect(specsB).not.toContain("mcp_beta_tool_05");
			expect(specsB).not.toContain("mcp_alpha_tool_02");
			expect(liveB.agent.state.tools.map((t: any) => t.name)).not.toContain("mcp_beta_tool_05");

			// Deny tool_02 on alpha (still 19 tools > 15 -> stays deferred, stale tool_02 pruned from A)
			await api("PATCH", "/mcp/alpha", { denyTools: ["tool_02"] });
			await (app.sessions as any).toolContext("preview", undefined, root).mcp.waitFor("alpha", 15_000);
			const afterDeny = (app.sessions as any).retargetTools(idA) as Array<{ name: string }> | undefined;
			expect(afterDeny?.map((t) => t.name)).toContain("mcp_beta_tool_05");
			expect(afterDeny?.map((t) => t.name)).not.toContain("mcp_alpha_tool_02");

			// Disable beta (total drops to 9 <= 15 -> automatically exits deferred mode and exposes alpha's 9 tools directly)
			await api("PATCH", "/mcp/beta", { enabled: false });
			const afterDisable = (app.sessions as any).retargetTools(idA) as Array<{ name: string }> | undefined;
			const namesAfterDisable = afterDisable!.map((t) => t.name);
			expect(namesAfterDisable).not.toContain(MCP_SEARCH_TOOL);
			expect(namesAfterDisable).not.toContain("mcp_beta_tool_05");
			expect(namesAfterDisable).toContain("mcp_alpha_tool_01");
			expect(namesAfterDisable).not.toContain("mcp_alpha_tool_02");

			// Re-enable beta -> back to deferred mode; pruned mcp_beta_tool_05 does NOT resurface as stale
			await api("PATCH", "/mcp/beta", { enabled: true });
			await (app.sessions as any).toolContext("preview", undefined, root).mcp.waitFor("beta", 15_000);
			const afterReenable = (app.sessions as any).retargetTools(idA) as Array<{ name: string }> | undefined;
			const namesAfterReenable = afterReenable!.map((t) => t.name);
			expect(namesAfterReenable).toContain(MCP_SEARCH_TOOL);
			expect(namesAfterReenable).not.toContain("mcp_beta_tool_05");

			// Transient server error does NOT permanently prune loaded tools; they return on recovery
			await searchA.execute("c4", { load: ["mcp_beta_tool_01"] });
			expect((app.sessions as any).retargetTools(idA)?.map((t: any) => t.name)).toContain("mcp_beta_tool_01");
			const mcpMgr = (app.sessions as any).mcp as McpManager;
			const betaConn = (mcpMgr as any).conns.get("beta");
			const savedBetaTools = betaConn.tools;
			betaConn.status = "error";
			betaConn.tools = [];
			app.sessions.notifyMcpToolsChanged();
			// While in error state, beta tools are hidden from active tools but NOT pruned from loadedMcpTools
			expect((app.sessions as any).loadedMcpTools.get(idA).has("mcp_beta_tool_01")).toBe(true);
			expect((app.sessions as any).retargetTools(idA)?.map((t: any) => t.name)).not.toContain("mcp_beta_tool_01");
			// Once beta recovers, mcp_beta_tool_01 is exposed again automatically
			betaConn.status = "ready";
			betaConn.tools = savedBetaTools;
			app.sessions.notifyMcpToolsChanged();
			expect((app.sessions as any).retargetTools(idA)?.map((t: any) => t.name)).toContain("mcp_beta_tool_01");

			// Deleting session A cleans up loadedMcpTools entry
			expect((app.sessions as any).loadedMcpTools.has(idA)).toBe(true);
			await api("DELETE", `/sessions/${idA}`);
			expect((app.sessions as any).loadedMcpTools.has(idA)).toBe(false);
		} finally {
			await app.close();
			upstream.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
