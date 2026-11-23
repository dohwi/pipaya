import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { classifyUpstreamError, completeWithUpstreamRetry, isTransientUpstreamError, isZeroOutputError, retryReason, withUpstreamRetry } from "../src/upstream-retry.ts";

const msg = (over: Partial<AssistantMessage>): AssistantMessage =>
	({ role: "assistant", content: [], stopReason: "stop", timestamp: 0, ...over }) as AssistantMessage;

const failing = (errorMessage: string) => {
	const s = createAssistantMessageEventStream();
	const error = msg({ stopReason: "error", errorMessage });
	s.push({ type: "start", partial: msg({}) });
	s.push({ type: "error", reason: "error", error });
	s.end(error);
	return s;
};
const ok = () => {
	const s = createAssistantMessageEventStream();
	const done = msg({ content: [{ type: "text", text: "hi" }] });
	s.push({ type: "start", partial: msg({}) });
	s.push({ type: "done", reason: "stop", message: done });
	s.end(done);
	return s;
};
const opts = (waits: number[], unknown: string[] = []) => ({ maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: async (ms: number) => { waits.push(ms); }, onUnknown: (m: string) => void unknown.push(m) });
const call = (fn: any) => fn({}, {}, {});

test("waits out a 502 and returns the later success", async () => {
	const waits: number[] = [];
	let n = 0;
	const fn = withUpstreamRetry((() => (++n < 3 ? failing("502 <html><title>502 Bad Gateway</title></html>") : ok())) as any, opts(waits));
	const result = await call(fn).result();
	expect(result.stopReason).toBe("stop");
	expect(n).toBe(3);
	expect(waits).toEqual([10, 20]);
});

test("gives up after maxRetries and reports the error", async () => {
	const waits: number[] = [];
	let n = 0;
	const fn = withUpstreamRetry((() => (n++, failing("502 Bad Gateway"))) as any, opts(waits));
	const result = await call(fn).result();
	expect(result.stopReason).toBe("error");
	expect(n).toBe(4);
});

test("does not retry errors that will not go away", async () => {
	let n = 0;
	const fn = withUpstreamRetry((() => (n++, failing("401 invalid api key"))) as any, opts([]));
	expect((await call(fn).result()).stopReason).toBe("error");
	expect(n).toBe(1);
});

test("an abort while waiting ends the run as aborted", async () => {
	const ac = new AbortController();
	const fn = withUpstreamRetry((() => failing("503 Service Unavailable")) as any, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: async () => ac.abort() });
	const result = await (fn as any)({}, {}, { signal: ac.signal }).result();
	expect(result.stopReason).toBe("aborted");
});

test("retryReason keeps the cause, drops secrets and markup, and caps the length", () => {
	expect(retryReason("502 <html><title>502 Bad Gateway</title></html>")).toBe("502 502 Bad Gateway");
	expect(retryReason("connect ECONNREFUSED http://user:pw@127.0.0.1:9/v1/chat?api_key=abc#x")).toBe("connect ECONNREFUSED http://127.0.0.1:9/v1/chat");
	expect(retryReason("401 Authorization: Bearer sk-abcdefghijklmnop1234")).not.toContain("abcdefgh");
	expect(retryReason("x-api-key: supersecretvalue failed")).not.toContain("supersecret");
	expect(retryReason(undefined)).toBe("");
	expect(retryReason("a".repeat(500)).length).toBe(200);
});

test("onRetry receives the failure message", async () => {
	const seen: string[] = [];
	let n = 0;
	const fn = withUpstreamRetry((() => (++n < 2 ? failing("503 Service Unavailable") : ok())) as any, { ...opts([]), onRetry: (_a, _m, _d, m) => void seen.push(m) });
	await call(fn).result();
	expect(seen).toEqual(["503 Service Unavailable"]);
});

test("retries a raw socket reset passed through by the gateway", async () => {
	const waits: number[] = [];
	let n = 0;
	const reset = "read tcp 172.24.0.3:57226->160.79.104.10:443: read: connection reset by peer";
	const fn = withUpstreamRetry((() => (++n < 2 ? failing(reset) : ok())) as any, opts(waits));
	expect((await call(fn).result()).stopReason).toBe("stop");
	expect(n).toBe(2);
});

test("isTransientUpstreamError covers socket failures but still refuses quota errors", () => {
	const err = (errorMessage: string) => msg({ stopReason: "error", errorMessage });
	for (const m of ["read: connection reset by peer", "write: broken pipe", "unexpected EOF", "ECONNRESET", "dial tcp: connect: no route to host", "502 Bad Gateway"])
		expect(isTransientUpstreamError(err(m))).toBe(true);
	for (const m of ["insufficient_quota: connection reset by peer", "401 invalid api key", "unexpected token in JSON"])
		expect(isTransientUpstreamError(err(m))).toBe(false);
	expect(isTransientUpstreamError(msg({ stopReason: "stop", errorMessage: "connection reset by peer" }))).toBe(false);
});

test("classifyUpstreamError sorts errors into transient, permanent and unknown", () => {
	const kind = (errorMessage: string) => classifyUpstreamError(msg({ stopReason: "error", errorMessage }));
	for (const m of [
		"503 Service Unavailable",
		"429 Too Many Requests",
		"overloaded_error",
		"connect ECONNREFUSED 127.0.0.1:9",
		"getaddrinfo ENOTFOUND api.example.com",
		"read: connection reset by peer",
		"request timed out",
		'502: {"message":"upstream stream closed with zero output","type":"server_error","code":"internal_server_error"}',
		"upstream stream closed with zero output",
		"upstream returned zero output with finishReason MALFORMED_FUNCTION_CALL",
		"Gemini stream closed with zero output",
		"Gemini response finished with UNEXPECTED_TOOL_CALL",
		"upstream stream closed before any chunk carried finish_reason",
		"upstream stream closed before [DONE]",
		"upstream stream closed before message_stop",
	])
		expect([m, kind(m)]).toEqual([m, "transient"]);
	for (const m of ["401 invalid api key", "403 Forbidden", "400 invalid_request_error: messages: field required", "404 model not found", "insufficient_quota", "quota exceeded: 500", "claude refusal (cyber): Cyber safeguards flagged this message", "prompt is too long: 250000 tokens > 200000 maximum"])
		expect([m, kind(m)]).toEqual([m, "permanent"]);
	for (const m of ["something odd happened", ""])
		expect([m, kind(m)]).toEqual([m, "unknown"]);
	expect(classifyUpstreamError(msg({ stopReason: "aborted", errorMessage: "503" }))).toBe("permanent");
	expect(classifyUpstreamError(msg({ stopReason: "stop" }))).toBe("permanent");
});

test("an unclassified error is retried once, after the shortest wait, and reported", async () => {
	const waits: number[] = [];
	const unknown: string[] = [];
	let n = 0;
	const fn = withUpstreamRetry((() => (++n < 2 ? failing("something odd happened") : ok())) as any, opts(waits, unknown));
	expect((await call(fn).result()).stopReason).toBe("stop");
	expect(n).toBe(2);
	expect(waits).toEqual([10]);
	expect(unknown).toEqual(["something odd happened"]);
});

test("an unclassified error that repeats ends the run after the single retry", async () => {
	let n = 0;
	const fn = withUpstreamRetry((() => (n++, failing("something odd happened"))) as any, opts([]));
	expect((await call(fn).result()).stopReason).toBe("error");
	expect(n).toBe(2);
});

test("an unclassified error does not use up the transient retries", async () => {
	let n = 0;
	const seq = ["something odd happened", "503 Service Unavailable", "503 Service Unavailable"];
	const fn = withUpstreamRetry((() => (n < seq.length ? failing(seq[n++]!) : (n++, ok()))) as any, { ...opts([]), maxRetries: 3 });
	expect((await call(fn).result()).stopReason).toBe("stop");
	expect(n).toBe(4);
});

test("a thrown unclassified error is retried once as well", async () => {
	let n = 0;
	const fn = withUpstreamRetry((() => { if (++n < 2) throw new Error("weird socket state"); return ok(); }) as any, opts([]));
	expect((await call(fn).result()).stopReason).toBe("stop");
	expect(n).toBe(2);
});

test("repeated zero-output failures nudge a copy of the trailing message on retry >= 2 without mutating context", async () => {
	const zeroErr = '502: {"message":"upstream stream closed with zero output","type":"server_error","code":"internal_server_error"}';
	expect(isZeroOutputError(zeroErr)).toBe(true);
	expect(isZeroOutputError("502 Bad Gateway")).toBe(false);
	expect(isZeroOutputError("403 safety: zero output")).toBe(false);

	const seen: string[] = [];
	const fn = withUpstreamRetry(((_m: unknown, ctx: Context) => {
		const tail = ctx.messages[ctx.messages.length - 1] as any;
		const text = Array.isArray(tail.content) ? tail.content.map((p: any) => p.text).join("\n") : tail.content;
		seen.push(text);
		return seen.length < 3 ? failing(zeroErr) : ok();
	}) as any, { ...opts([]), maxRetries: 4 });

	const originalParts = [{ type: "text" as const, text: "tool done" }];
	const baseCtx = { messages: [{ role: "toolResult" as const, toolCallId: "c1", toolName: "bash", content: originalParts, isError: false, timestamp: 1 }] } as unknown as Context;
	expect((await (fn as any)({}, baseCtx, {}).result()).stopReason).toBe("stop");
	expect(seen[0]).toBe("tool done");
	expect(seen[1]).toBe("tool done");
	expect(seen[2]).toContain("tool done");
	expect(seen[2]).toContain("Upstream closed the previous attempt with zero output (retry 2)");
	expect(originalParts).toEqual([{ type: "text", text: "tool done" }]);

	seen.length = 0;
	const nextCtx = { messages: [...baseCtx.messages, { role: "user" as const, content: "next", timestamp: 2 }] } as unknown as Context;
	expect((await (fn as any)({}, nextCtx, {}).result()).stopReason).toBe("stop");
	expect(seen[0]).toBe("next");
});

test("post-thinking zero-output errors also count toward the streak across outer STREAM_RETRY restarts", async () => {
	const postThoughtZero = (errorMessage: string) => {
		const s = createAssistantMessageEventStream();
		const partial = msg({ content: [{ type: "thinking", thinking: "planning" }] as any });
		const error = msg({ stopReason: "error", errorMessage, content: partial.content });
		s.push({ type: "start", partial });
		s.push({ type: "thinking_start", contentIndex: 0, partial });
		s.push({ type: "error", reason: "error", error });
		s.end(error);
		return s;
	};
	const seen: string[] = [];
	let calls = 0;
	const fn = withUpstreamRetry(((_m: unknown, ctx: Context) => {
		const tail = ctx.messages[ctx.messages.length - 1] as any;
		seen.push(String(tail.content));
		return ++calls < 3 ? postThoughtZero("upstream returned zero output with finishReason MALFORMED_FUNCTION_CALL") : ok();
	}) as any, opts([]));

	const sameTail = { messages: [{ role: "user" as const, content: "run ls", timestamp: 10 }] } as unknown as Context;
	expect((await (fn as any)({}, sameTail, {}).result()).stopReason).toBe("error");
	expect((await (fn as any)({}, sameTail, {}).result()).stopReason).toBe("error");
	expect((await (fn as any)({}, sameTail, {}).result()).stopReason).toBe("stop");
	expect(seen[0]).toBe("run ls");
	expect(seen[1]).toBe("run ls");
	expect(seen[2]).toContain("Upstream closed the previous attempt with zero output (retry 2)");
});

test("completeWithUpstreamRetry retries transient 502 zero-output errors and returns permanent/unknown ones immediately", async () => {
	const waits: number[] = [];
	let calls = 0;
	const zeroErr = '502: {"message":"upstream stream closed with zero output","type":"server_error","code":"internal_server_error"}';
	const baseCtx = { messages: [{ role: "user" as const, content: "summarize this", timestamp: 1 }] } as unknown as Context;
	const seen: string[] = [];
	const reply = await completeWithUpstreamRetry(
		async (ctx) => {
			seen.push(String((ctx.messages[0] as any).content));
			return ++calls < 4 ? msg({ stopReason: "error", errorMessage: zeroErr }) : msg({ content: [{ type: "text", text: "summary" }] });
		},
		baseCtx,
		{ maxRetries: 3, baseDelayMs: 5, maxDelayMs: 50, sleep: async (ms) => void waits.push(ms) },
	);
	expect(reply.stopReason).toBe("stop");
	expect(calls).toBe(4);
	expect(waits).toEqual([5, 10, 20]);
	expect(seen[0]).toBe("summarize this");
	expect(seen[1]).toBe("summarize this");
	expect(seen[2]).toContain("retry 2");

	const noWaits: number[] = [];
	let permCalls = 0;
	const perm = await completeWithUpstreamRetry(
		async () => (permCalls++, msg({ stopReason: "error", errorMessage: "boom" })),
		baseCtx,
		{ maxRetries: 3, baseDelayMs: 5, maxDelayMs: 50, sleep: async (ms) => void noWaits.push(ms) },
	);
	expect(perm.stopReason).toBe("error");
	expect(permCalls).toBe(1);
	expect(noWaits).toEqual([]);
});
