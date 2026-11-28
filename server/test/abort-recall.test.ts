import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { hasAssistantOutputOrTools } from "../src/run-guard.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

type StreamMode = "silent-hang" | "thinking-hang" | "text-hang" | "tool-hang" | "ok";

function startControlledUpstream() {
	let mode: StreamMode = "ok";
	let onRequestStarted: (() => void) | null = null;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
			await req.json();
			const enc = new TextEncoder();
			const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
				enc.encode(
					`data: ${JSON.stringify({
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 1,
						model: "ctrl-model",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			const current = mode;
			const stream = new ReadableStream({
				start(controller) {
					const hang = () => {
						onRequestStarted?.();
						onRequestStarted = null;
						req.signal.addEventListener(
							"abort",
							() => {
								try { controller.close(); } catch { /* already closed */ }
							},
							{ once: true },
						);
					};
					if (current === "silent-hang") {
						controller.enqueue(frame({ role: "assistant" }));
						hang();
						return;
					}
					if (current === "thinking-hang") {
						controller.enqueue(frame({ role: "assistant", reasoning_content: "considering options..." }));
						hang();
						return;
					}
					if (current === "text-hang") {
						controller.enqueue(frame({ role: "assistant", content: "Partial answer" }));
						hang();
						return;
					}
					if (current === "tool-hang") {
						controller.enqueue(
							frame({
								role: "assistant",
								tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"sleep 30"}' } }],
							}),
						);
						controller.enqueue(frame({}, "tool_calls"));
						controller.enqueue(enc.encode("data: [DONE]\n\n"));
						controller.close();
						onRequestStarted?.();
						onRequestStarted = null;
						return;
					}
					controller.enqueue(frame({ role: "assistant", content: "Done." }));
					controller.enqueue(frame({}, "stop"));
					controller.enqueue(enc.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		setMode(m: StreamMode) {
			mode = m;
		},
		waitForRequest(): Promise<void> {
			return new Promise((resolve) => {
				onRequestStarted = resolve;
			});
		},
		stop() {
			server.stop(true);
		},
	};
}

const makeEnv = () => {
	const dir = mkdtempSync(join(tmpdir(), "pipaya-abort-recall-"));
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

async function setup() {
	const upstream = startControlledUpstream();
	cleanups.push(() => upstream.stop());
	const env = makeEnv();
	const app = await buildApp(env.cfg);
	cleanups.push(() => app.close());
	const api = clientFor(app);
	expect(
		(
			await api("PUT", "/configuration/providers/ctrl", {
				name: "Controlled",
				baseUrl: upstream.baseUrl,
				api: "openai-completions",
				authRequired: false,
				models: [{ id: "ctrl-model", name: "Ctrl", contextWindow: 8192, maxTokens: 1024, reasoning: true, vision: false }],
			})
		).status,
	).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "ctrl", model: "ctrl-model" })).status).toBe(200);
	return { app, api, upstream };
}

async function untilIdle(api: ReturnType<typeof clientFor>, id: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(15);
	}
	throw new Error(`session ${id} never went idle`);
}

function lastRunFinished(app: App, sessionId: string): any {
	const events = app.bus.history({ sessionId, after: 0, limit: 200 });
	const found = [...events].reverse().find((e) => e.type === "run_finished");
	return found?.data;
}

describe("hasAssistantOutputOrTools", () => {
	test("treats thinking-only and whitespace-only assistant messages as having no output", () => {
		expect(hasAssistantOutputOrTools({ role: "assistant", content: [] })).toBe(false);
		expect(hasAssistantOutputOrTools({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] })).toBe(false);
		expect(hasAssistantOutputOrTools({ role: "assistant", content: [{ type: "text", text: "   \n  " }] })).toBe(false);
		expect(hasAssistantOutputOrTools({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toBe(true);
		expect(hasAssistantOutputOrTools({ role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] })).toBe(true);
	});
});

describe("abort prompt recall", () => {
	test("recalls user prompt and rolls back DB + memory when aborted before any assistant output", async () => {
		const { app, api, upstream } = await setup();
		const id = (await api("POST", "/sessions", {})).json.id as string;

		upstream.setMode("silent-hang");
		const started = upstream.waitForRequest();
		expect((await api("POST", `/sessions/${id}/messages`, { text: "recall me" })).status).toBe(202);
		await started;
		await Bun.sleep(30);

		expect((await api("POST", `/sessions/${id}/abort`)).json.aborted).toBe(true);
		await untilIdle(api, id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		expect(msgs).toEqual([]);
		const fin = lastRunFinished(app, id);
		expect(fin.status).toBe("aborted");
		expect(fin.cause).toBe("user");
		expect(fin.recalledPrompt).toEqual({ text: "recall me", fromSeq: 0 });

		// Follow-up send reuses seq 0 cleanly.
		upstream.setMode("ok");
		expect((await api("POST", `/sessions/${id}/messages`, { text: "fresh prompt" })).status).toBe(202);
		await untilIdle(api, id);
		const after = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		expect(after.map((m: any) => [m.seq, m.role])).toEqual([[0, "user"], [1, "assistant"]]);
	});

	test("recalls user prompt when aborted during thinking-only phase (before text or tool calls)", async () => {
		const { app, api, upstream } = await setup();
		const id = (await api("POST", "/sessions", {})).json.id as string;

		// Seed a prior completed turn so we also verify earlier history stays untouched.
		upstream.setMode("ok");
		await api("POST", `/sessions/${id}/messages`, { text: "turn 1" });
		await untilIdle(api, id);

		upstream.setMode("thinking-hang");
		const started = upstream.waitForRequest();
		await api("POST", `/sessions/${id}/messages`, { text: "turn 2 thinking only" });
		await started;
		await Bun.sleep(40);

		await api("POST", `/sessions/${id}/abort`);
		await untilIdle(api, id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		expect(msgs.map((m: any) => [m.seq, m.role])).toEqual([[0, "user"], [1, "assistant"]]);
		const fin = lastRunFinished(app, id);
		expect(fin.recalledPrompt).toEqual({ text: "turn 2 thinking only", fromSeq: 2 });
	});

	test("does NOT recall prompt when assistant has already streamed visible text", async () => {
		const { app, api, upstream } = await setup();
		const id = (await api("POST", "/sessions", {})).json.id as string;

		upstream.setMode("text-hang");
		const started = upstream.waitForRequest();
		await api("POST", `/sessions/${id}/messages`, { text: "keep me" });
		await started;
		await Bun.sleep(40);

		await api("POST", `/sessions/${id}/abort`);
		await untilIdle(api, id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		expect(msgs.map((m: any) => [m.seq, m.role])).toEqual([[0, "user"], [1, "assistant"]]);
		const fin = lastRunFinished(app, id);
		expect(fin.status).toBe("aborted");
		expect(fin.cause).toBe("user");
		expect(fin.recalledPrompt).toBeUndefined();
	});

	test("does NOT recall prompt when assistant has already started a tool call", async () => {
		const { app, api, upstream } = await setup();
		const id = (await api("POST", "/sessions", {})).json.id as string;

		upstream.setMode("tool-hang");
		await api("POST", `/sessions/${id}/messages`, { text: "run tool" });
		for (let i = 0; i < 100; i++) {
			if ((await api("GET", `/sessions/${id}/status`)).json.pendingToolCalls.length > 0) break;
			await Bun.sleep(20);
		}

		await api("POST", `/sessions/${id}/abort`);
		await untilIdle(api, id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
		expect(msgs.length).toBeGreaterThanOrEqual(2);
		expect(msgs[0].role).toBe("user");
		const fin = lastRunFinished(app, id);
		expect(fin.recalledPrompt).toBeUndefined();
	});

	test("does NOT recall peer, schedule, or goal runs on abort", async () => {
		const { app, api, upstream } = await setup();
		for (const origin of ["peer", "schedule", "goal"] as const) {
			const id = (await api("POST", "/sessions", {})).json.id as string;
			upstream.setMode("silent-hang");
			const started = upstream.waitForRequest();
			await app.sessions.send(id, { text: `auto ${origin}`, origin });
			await started;
			await Bun.sleep(30);

			await api("POST", `/sessions/${id}/abort`);
			await untilIdle(api, id);

			const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages;
			expect(msgs.length).toBeGreaterThanOrEqual(1);
			expect(msgs[0].role).toBe("user");
			const fin = lastRunFinished(app, id);
			expect(fin.cause).toBe("user");
			expect(fin.recalledPrompt).toBeUndefined();
		}
	});

	test("recalling prompt coexists cleanly with queued steer/follow_up drops", async () => {
		const { app, api, upstream } = await setup();
		const id = (await api("POST", "/sessions", {})).json.id as string;

		upstream.setMode("silent-hang");
		const started = upstream.waitForRequest();
		await api("POST", `/sessions/${id}/messages`, { text: "first prompt" });
		await started;
		await Bun.sleep(30);
		expect((await api("POST", `/sessions/${id}/messages`, { text: "queued steer", mode: "steer" })).status).toBe(202);
		expect((await api("POST", `/sessions/${id}/messages`, { text: "queued follow", mode: "follow_up" })).status).toBe(202);

		await api("POST", `/sessions/${id}/abort`);
		await untilIdle(api, id);

		expect((await api("GET", `/sessions/${id}/messages`)).json.messages).toEqual([]);
		const events = app.bus.history({ sessionId: id, after: 0, limit: 200 });
		const dequeued = events.filter((e) => e.type === "message_dequeued").map((e) => e.data);
		expect(dequeued).toEqual([
			{ mode: "steer", text: "queued steer", reason: "stopped" },
			{ mode: "follow_up", text: "queued follow", reason: "stopped" },
		]);
		expect(lastRunFinished(app, id).recalledPrompt).toEqual({ text: "first prompt", fromSeq: 0 });
	});
});
