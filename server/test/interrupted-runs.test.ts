import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App, type BuildOptions } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { RESTART_RUN_ERROR, RESTART_TOOL_ERROR, SHUTDOWN_RUN_ERROR, SHUTDOWN_TOOL_ERROR } from "../src/run-guard.ts";
import { interruptedAssistantMessage, interruptedToolResult, unresolvedToolCalls } from "../src/session-helpers.ts";
import { SessionStore } from "../src/store.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

const makeEnv = () => {
	const dir = mkdtempSync(join(tmpdir(), "pipaya-interrupted-"));
	const ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const cfg: Config = {
		host: "0.0.0.0",
		port: 0,
		dataDir: dir,
		dbPath: join(dir, "db.sqlite"),
		token: "test-token",
		workspaceRoot: ws,
		logLevel: "silent",
	};
	return { dir, ws, cfg };
};

const clientFor = (app: App) => async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

async function configureEcho(app: App, upstream: EchoUpstream): Promise<void> {
	const api = clientFor(app);
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
}

async function untilIdle(app: App, id: string): Promise<void> {
	const api = clientFor(app);
	for (let i = 0; i < 400; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(15);
	}
	throw new Error(`session ${id} never went idle`);
}

describe("unresolvedToolCalls helper", () => {
	test("finds tool calls from the latest assistant turn without matching toolResults", () => {
		const msgs: any[] = [
			{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", id: "c2", name: "delegate", arguments: { role: "explore", task: "x" } },
				],
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
		];
		expect(unresolvedToolCalls(msgs)).toEqual([{ id: "c2", name: "delegate" }]);
		expect(interruptedToolResult({ id: "c2", name: "delegate" }, "cut off", 4)).toMatchObject({
			role: "toolResult",
			toolCallId: "c2",
			toolName: "delegate",
			isError: true,
		});
		expect(interruptedAssistantMessage({ provider: "echo", model: "echo-model" }, "boom", 5)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "boom",
			content: [],
		});
	});
});

describe("graceful server shutdown (SIGTERM / app.close)", () => {
	test("marks an active tool run as error (never silent idle or user abort), records unread failed, and allows retry after restart", async () => {
		const { ws, cfg } = makeEnv();
		const upstream = startEchoUpstream();
		cleanups.push(() => upstream.stop());

		const app1 = await buildApp(cfg, { strictResponses: true });
		await configureEcho(app1, upstream);
		const api1 = clientFor(app1);

		const id = (await api1("POST", "/sessions", { cwd: ws })).json.id as string;
		await api1("POST", `/sessions/${id}/messages`, { text: "!bash sleep 30" });
		for (let i = 0; i < 200; i++) {
			if ((await api1("GET", `/sessions/${id}/status`)).json.pendingToolCalls.length > 0) break;
			await Bun.sleep(15);
		}

		// Graceful shutdown while bash tool is mid-flight.
		await app1.close();

		// Boot a new server instance on the same database.
		const app2 = await buildApp(cfg, { strictResponses: true });
		cleanups.push(() => app2.close());
		const api2 = clientFor(app2);

		const msgs = (await api2("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const toolRes = msgs.find((m) => m.role === "toolResult");
		expect(toolRes).toBeDefined();
		expect(toolRes.message.isError).toBe(true);
		expect(toolRes.message.content[0].text).toBe(SHUTDOWN_TOOL_ERROR);

		const last = msgs.at(-1);
		expect(last.role).toBe("assistant");
		expect(last.message.stopReason).toBe("error");
		expect(last.message.errorMessage).toBe(SHUTDOWN_RUN_ERROR);

		const history = (await api2("GET", `/events/history?sessionId=${id}`)).json.events as any[];
		const finished = history.filter((e) => e.type === "run_finished").at(-1);
		expect(finished.data).toMatchObject({
			status: "error",
			error: SHUTDOWN_RUN_ERROR,
			cause: "shutdown",
		});

		const activity = (await api2("GET", "/activity")).json;
		expect(activity.unread).toContainEqual({ sessionId: id, kind: "failed" });

		// Retry continues cleanly from the interrupted toolResult.
		expect((await api2("POST", `/sessions/${id}/retry`)).status).toBe(202);
		await untilIdle(app2, id);
		const retried = (await api2("GET", `/sessions/${id}/messages`)).json.messages as any[];
		expect(retried.at(-1).message.stopReason).toBe("stop");
	});

	test("preserves streamed partial text and upgrades stopReason from aborted to error on shutdown", async () => {
		const { ws, cfg } = makeEnv();
		let startedStreaming = false;
		const upstream = startEchoUpstream((body) => {
			const last = body.messages?.at(-1);
			if (last?.role === "user" && JSON.stringify(last.content).includes("hang-stream")) {
				const enc = new TextEncoder();
				return new Response(
					new ReadableStream({
						start(controller) {
							const chunk = {
								id: "chatcmpl-hang",
								object: "chat.completion.chunk",
								created: 1,
								model: ECHO_MODEL.id,
								choices: [{ index: 0, delta: { role: "assistant", content: "Partial reply before reboot" }, finish_reason: null }],
							};
							controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
							startedStreaming = true;
							// Leave stream open until the server aborts on shutdown.
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return undefined;
		});
		cleanups.push(() => upstream.stop());

		const app1 = await buildApp(cfg, { strictResponses: true });
		await configureEcho(app1, upstream);
		const api1 = clientFor(app1);

		const id = (await api1("POST", "/sessions", { cwd: ws })).json.id as string;
		await api1("POST", `/sessions/${id}/messages`, { text: "hang-stream" });
		for (let i = 0; i < 200 && !startedStreaming; i++) await Bun.sleep(15);
		await Bun.sleep(30);

		await app1.close();

		const app2 = await buildApp(cfg, { strictResponses: true });
		cleanups.push(() => app2.close());
		const api2 = clientFor(app2);

		const msgs = (await api2("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const last = msgs.at(-1);
		expect(last.role).toBe("assistant");
		expect(last.message.stopReason).toBe("error");
		expect(last.message.errorMessage).toBe(SHUTDOWN_RUN_ERROR);
		expect(JSON.stringify(last.message.content)).toContain("Partial reply before reboot");
	});

	test("forcibly finalizes a stuck tool that ignores abort within shutdownStopMs without hanging close()", async () => {
		const { dir, ws, cfg } = makeEnv();
		const extDir = join(dir, "ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "stuck-tool.ts"),
			`export default function (pi: any) {
				pi.registerTool({
					name: "stuck_tool",
					description: "Never resolves and ignores abort",
					parameters: { type: "object", properties: {} },
					async execute() { return await new Promise(() => {}); },
				});
			}`,
		);
		const upstream = startEchoUpstream();
		cleanups.push(() => upstream.stop());

		const opts: BuildOptions = { strictResponses: true, extensionPaths: [join(extDir, "stuck-tool.ts")], shutdownStopMs: 60 };
		const app1 = await buildApp(cfg, opts);
		await configureEcho(app1, upstream);
		const api1 = clientFor(app1);

		const id = (await api1("POST", "/sessions", { cwd: ws, tools: ["stuck_tool"] })).json.id as string;
		await api1("POST", `/sessions/${id}/messages`, { text: "!stuck_tool {}" });
		for (let i = 0; i < 200; i++) {
			if ((await api1("GET", `/sessions/${id}/status`)).json.pendingToolCalls.length > 0) break;
			await Bun.sleep(15);
		}

		const t0 = Date.now();
		await app1.close();
		expect(Date.now() - t0).toBeLessThan(2000);

		const app2 = await buildApp(cfg, { strictResponses: true, extensionPaths: [join(extDir, "stuck-tool.ts")] });
		cleanups.push(() => app2.close());
		const api2 = clientFor(app2);

		const msgs = (await api2("GET", `/sessions/${id}/messages`)).json.messages as any[];
		expect(msgs.find((m) => m.role === "toolResult")?.message).toMatchObject({
			toolName: "stuck_tool",
			isError: true,
			content: [{ type: "text", text: SHUTDOWN_TOOL_ERROR }],
		});
		expect(msgs.at(-1).message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: SHUTDOWN_RUN_ERROR,
		});
		expect((await api2("GET", "/activity")).json.unread).toContainEqual({ sessionId: id, kind: "failed" });
	});
});

describe("hard crash / SIGKILL / sudden reboot recovery on startup", () => {
	test("recovers orphaned active_runs (after prompt, mid-tool / mid-delegate, and pre-prompt) as retryable errors and notifies watchers", async () => {
		const { ws, cfg } = makeEnv();
		const upstream = startEchoUpstream();
		cleanups.push(() => upstream.stop());

		// Seed sessions using a normal app, then close cleanly and inject mid-flight crash states directly into SQLite
		// (exact state left behind when the OS kills the process without running shutdown hooks).
		const seedApp = await buildApp(cfg, { strictResponses: true });
		await configureEcho(seedApp, upstream);
		const seedApi = clientFor(seedApp);

		const sPrompt = (await seedApi("POST", "/sessions", { cwd: ws, title: "Prompt crash" })).json.id as string;
		const sTool = (await seedApi("POST", "/sessions", { cwd: ws, title: "Tool crash" })).json.id as string;
		const sPre = (await seedApi("POST", "/sessions", { cwd: ws, title: "Pre-prompt crash" })).json.id as string;
		const sWatcher = (await seedApi("POST", "/sessions", { cwd: ws, title: "Watcher" })).json.id as string;
		await seedApp.close();

		const rawDb = openDb(cfg.dbPath);
		const rawStore = new SessionStore(rawDb);
		const now = Date.now();

		// 1) sPrompt: user message persisted, died before any assistant message arrived.
		rawStore.appendMessage(sPrompt, 0, { role: "user", content: [{ type: "text", text: "after crash prompt" }], timestamp: now } as any);
		rawStore.markRunActive(sPrompt, { origin: "user", startedAt: now - 500 });

		// 2) sTool: assistant requested bash + delegate toolCalls, died before toolResults arrived; watched by sWatcher.
		rawStore.appendMessage(sTool, 0, { role: "user", content: [{ type: "text", text: "run tools" }], timestamp: now } as any);
		rawStore.appendMessage(sTool, 1, {
			role: "assistant",
			api: "openai-completions",
			provider: "echo",
			model: ECHO_MODEL.id,
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [
				{ type: "toolCall", id: "call_bash_1", name: "bash", arguments: { command: "sleep 10" } },
				{ type: "toolCall", id: "call_del_1", name: "delegate", arguments: { role: "explore", task: "inspect" } },
			],
			timestamp: now,
		} as any);
		rawStore.markRunActive(sTool, { origin: "peer", startedAt: now - 1000 });
		rawStore.watch(sTool, sWatcher);

		// 3) sPre: died during autoCompact / before_agent_start before the user message reached `messages`.
		rawStore.markRunActive(sPre, {
			origin: "user",
			startedAt: now - 200,
			pendingPrompt: { role: "user", content: [{ type: "text", text: "saved from pending_prompt" }], timestamp: now } as any,
		});
		rawDb.close();

		// Start the recovered server.
		const app = await buildApp(cfg, { strictResponses: true });
		cleanups.push(() => app.close());
		const api = clientFor(app);

		// Verify sPrompt
		const promptMsgs = (await api("GET", `/sessions/${sPrompt}/messages`)).json.messages as any[];
		expect(promptMsgs).toHaveLength(2);
		expect(promptMsgs[1].message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: RESTART_RUN_ERROR,
		});

		// Verify sTool: both orphaned toolCalls got error toolResults, delegate is no longer dangling, and trailing error assistant was added.
		const toolMsgs = (await api("GET", `/sessions/${sTool}/messages`)).json.messages as any[];
		const toolResults = toolMsgs.filter((m) => m.role === "toolResult").map((m) => m.message);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((t) => [t.toolCallId, t.isError, t.content[0].text])).toEqual([
			["call_bash_1", true, RESTART_TOOL_ERROR],
			["call_del_1", true, RESTART_TOOL_ERROR],
		]);
		expect(toolMsgs.at(-1).message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: RESTART_RUN_ERROR,
		});
		const delegates = (await api("GET", "/delegates")).json.runs as any[];
		const delRun = delegates.find((d) => d.callId === "call_del_1");
		expect(delRun).toMatchObject({ running: false, error: true });
		expect(delRun.doneAt).not.toBeNull();

		// Verify sPre: pending user prompt was restored and followed by the error assistant message.
		const preMsgs = (await api("GET", `/sessions/${sPre}/messages`)).json.messages as any[];
		expect(preMsgs.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(preMsgs[0].message.content[0].text).toBe("saved from pending_prompt");
		expect(preMsgs[1].message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: RESTART_RUN_ERROR,
		});

		// Unread failed marks exist for user-originated crashed runs.
		const unread = (await api("GET", "/activity")).json.unread as any[];
		expect(unread).toContainEqual({ sessionId: sPrompt, kind: "failed" });
		expect(unread).toContainEqual({ sessionId: sPre, kind: "failed" });

		// Watcher session received the error report from sTool's recovery (delivery is asynchronous, so wait for its message first).
		for (let i = 0; i < 200; i++) {
			const cur = (await api("GET", `/sessions/${sWatcher}/messages`)).json.messages as any[];
			if (cur.length > 0) break;
			await Bun.sleep(15);
		}
		await untilIdle(app, sWatcher);
		const watcherMsgs = (await api("GET", `/sessions/${sWatcher}/messages`)).json.messages as any[];
		expect(JSON.stringify(watcherMsgs)).toContain(RESTART_RUN_ERROR);

		// All three recovered sessions can be retried cleanly without 409 errors.
		for (const id of [sPrompt, sTool, sPre]) {
			expect((await api("POST", `/sessions/${id}/retry`)).status).toBe(202);
			await untilIdle(app, id);
			const afterRetry = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
			expect(afterRetry.at(-1).message.stopReason).toBe("stop");
		}
	});
});

describe("manual abort vs pre-prompt runtime failure", () => {
	test("manual user abort stays aborted (not an error or unread failure)", async () => {
		const { ws, cfg } = makeEnv();
		const upstream = startEchoUpstream();
		cleanups.push(() => upstream.stop());

		const app = await buildApp(cfg, { strictResponses: true });
		cleanups.push(() => app.close());
		await configureEcho(app, upstream);
		const api = clientFor(app);

		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!bash sleep 30" });
		for (let i = 0; i < 200; i++) {
			if ((await api("GET", `/sessions/${id}/status`)).json.pendingToolCalls.length > 0) break;
			await Bun.sleep(15);
		}

		expect((await api("POST", `/sessions/${id}/abort`)).json.aborted).toBe(true);
		await untilIdle(app, id);

		const history = (await api("GET", `/events/history?sessionId=${id}`)).json.events as any[];
		const finished = history.filter((e) => e.type === "run_finished").at(-1);
		expect(finished.data).toMatchObject({ status: "aborted", cause: "user" });
		expect((await api("GET", "/activity")).json.unread).toEqual([]);
	});

	test("a runtime failure before agent.prompt() still persists the user prompt and a retryable error reply", async () => {
		const { ws, cfg } = makeEnv();
		const upstream = startEchoUpstream();
		cleanups.push(() => upstream.stop());

		const app = await buildApp(cfg, { strictResponses: true });
		cleanups.push(() => app.close());
		await configureEcho(app, upstream);
		const api = clientFor(app);

		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		const origAutoCompact = (app.sessions as any).autoCompact.bind(app.sessions);
		let failOnce = true;
		(app.sessions as any).autoCompact = async (sid: string) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("unexpected pre-prompt crash");
			}
			return origAutoCompact(sid);
		};

		await api("POST", `/sessions/${id}/messages`, { text: "hello before pre-prompt crash" });
		await untilIdle(app, id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(msgs[0].message.content[0].text).toBe("hello before pre-prompt crash");
		expect(msgs[1].message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "unexpected pre-prompt crash",
		});

		expect((await api("POST", `/sessions/${id}/retry`)).status).toBe(202);
		await untilIdle(app, id);
		const afterRetry = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		expect(afterRetry.at(-1).message.stopReason).toBe("stop");
	});
});
