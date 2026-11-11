import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { retryReason, withUpstreamRetry } from "../src/upstream-retry.ts";

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
const opts = (waits: number[]) => ({ maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: async (ms: number) => { waits.push(ms); } });
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
