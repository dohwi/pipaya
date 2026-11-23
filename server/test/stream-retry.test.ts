import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ECHO_MODEL, echoProviderBody, startEchoUpstream, type EchoUpstream } from "./support/openai-upstream.ts";

let app: App;
let dir: string;
let ws: string;
let upstream: EchoUpstream;
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
	dir = mkdtempSync(join(tmpdir(), "pipaya-stream-retry-"));
	ws = join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	const textOf = (content: any) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "");
	const faulted = new Set<string>();
	upstream = startEchoUpstream((body) => {
		const msgs: any[] = body?.messages ?? [];
		const lastContent = textOf(msgs.at(-1)?.content);
		if (lastContent === "zero502-probe summarize ok" && !faulted.has("zero502")) {
			faulted.add("zero502");
			return Response.json(
				{ error: { message: "upstream stream closed with zero output", type: "server_error", code: "internal_server_error" } },
				{ status: 502 },
			);
		}
		if (lastContent === "subdrop-probe check files" && !faulted.has("subdrop")) {
			faulted.add("subdrop");
			const enc = new TextEncoder();
			const thought = { id: "chatcmpl-echo", object: "chat.completion.chunk", created: 1, model: ECHO_MODEL.id, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "planning..." }, finish_reason: null }] };
			const errChunk = { error: { message: "upstream returned zero output with finishReason MALFORMED_FUNCTION_CALL", type: "server_error", code: "internal_server_error" } };
			return new Response(new ReadableStream({
				start(c) {
					c.enqueue(enc.encode(`data: ${JSON.stringify(thought)}\n\n`));
					c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify(errChunk)}\n\n`));
					c.close();
				},
			}), { headers: { "content-type": "text/event-stream" } });
		}
		return undefined;
	});
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: ws, logLevel: "silent" };
	app = await buildApp(cfg, { home: join(dir, "home"), strictResponses: true });
	expect((await api("PUT", "/configuration/providers/echo", echoProviderBody(upstream.baseUrl))).status).toBe(200);
	expect((await api("PUT", "/configuration/defaults", { provider: "echo", model: ECHO_MODEL.id })).status).toBe(200);
	expect((await api("PUT", "/configuration/delegate", { roles: "any", policy: "defined", models: [], maxConcurrent: 4, maxCalls: 12, maxTurns: 30 })).status).toBe(200);
});
afterAll(async () => {
	await app.close();
	upstream.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function untilIdle(id: string) {
	for (let i = 0; i < 500; i++) {
		if (!(await api("GET", `/sessions/${id}/status`)).json.running) return;
		await Bun.sleep(20);
	}
	throw new Error("never idle");
}

describe("a stream cut off mid-reply", () => {
	// The wait before the retry is real (2s): this test costs a couple of seconds on purpose.
	test("is dropped and the request repeated, so the run ends with the retried answer", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!drop hello" });
		await untilIdle(id);

		// Two requests: the one that was cut, then the retry that answered.
		expect(upstream.requests.filter((r) => r.path.endsWith("/chat/completions"))).toHaveLength(2);
		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const assistant = msgs.filter((m) => m.role === "assistant").map((m) => m.message);
		expect(assistant).toHaveLength(1); // the half-written reply is not kept
		expect(assistant[0].stopReason).toBe("stop");
		expect(JSON.stringify(assistant[0].content)).toContain("Echo: hello");
		expect((await api("GET", `/sessions/${id}/status`)).json.lastError).toBeNull();
	});
});

describe("a reply the output limit cut off", () => {
	test("is kept as written with stopReason length, and the next prompt goes on from it with the cut text in context", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: "!cut a long answer" });
		await untilIdle(id);
		let msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const cut = msgs.filter((m) => m.role === "assistant").map((m) => m.message);
		expect(cut).toHaveLength(1);
		expect(cut[0].stopReason).toBe("length");
		expect(JSON.stringify(cut[0].content)).toContain("Echo: a long answer");
		// not an error: nothing to retry, no error reported
		expect((await api("GET", `/sessions/${id}/status`)).json.lastError).toBeNull();
		expect((await api("POST", `/sessions/${id}/retry`)).status).toBe(409);

		// "continue" is an ordinary prompt; the model sees its own cut reply right before it
		const before = upstream.requests.length;
		expect((await api("POST", `/sessions/${id}/messages`, { text: "go on" })).status).toBe(202);
		await untilIdle(id);
		const sent = upstream.requests.slice(before).find((r) => r.path.endsWith("/chat/completions"))!.body.messages as any[];
		const tail = sent.slice(-2);
		expect(tail[0].role).toBe("assistant");
		expect(JSON.stringify(tail[0].content)).toContain("Echo: a long answer");
		expect(tail[1]).toMatchObject({ role: "user" });
		msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		expect(msgs.filter((m) => m.role === "assistant").at(-1).message.stopReason).toBe("stop");
	});
});

describe("zero-output 502 and post-thinking subagent stream failures", () => {
	test("one-shot /llm/complete waits out a 502 upstream zero-output error", async () => {
		const before = upstream.requests.length;
		const r = await api("POST", "/llm/complete", { input: "zero502-probe summarize ok" });
		expect(r.status).toBe(200);
		expect(r.json.text).toBe("Echo: zero502-probe summarize ok");
		expect(upstream.requests.slice(before).filter((req) => req.path.endsWith("/chat/completions"))).toHaveLength(2);
	});

	test("a subagent delegate cut off after thinking by a zero-output SSE error retries and succeeds", async () => {
		const id = (await api("POST", "/sessions", { cwd: ws })).json.id as string;
		await api("POST", `/sessions/${id}/messages`, { text: '!delegate {"role":"explore","task":"subdrop-probe check files"}' });
		await untilIdle(id);

		const msgs = (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];
		const toolRes = msgs.find((m) => m.role === "toolResult");
		expect(toolRes).toBeDefined();
		expect(toolRes.message.isError).toBe(false);
		expect(JSON.stringify(toolRes.message.content)).toContain("Echo: subdrop-probe check files");
		expect((await api("GET", `/sessions/${id}/status`)).json.lastError).toBeNull();
	});
});
