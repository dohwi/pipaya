import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
	completeSummaryWithShrinkRetry,
	CONCISE_SUMMARY_INSTRUCTION,
	MAX_SUMMARY_SHRINK_RETRIES,
	MIN_SUMMARY_BUDGET_CHARS,
	nextSummaryBudget,
	transcript,
} from "../src/compaction.ts";

const makeUser = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;

const makeLongMessages = (count = 12, chunkLen = 1500): AgentMessage[] =>
	Array.from({ length: count }, (_, i) => makeUser(`turn-${i}: ${"x".repeat(chunkLen)}`));

const okReply = (text = "compact summary"): AssistantMessage => ({
	role: "assistant",
	api: "openai-completions",
	provider: "echo",
	model: "echo-1",
	content: [{ type: "text", text }],
	stopReason: "stop",
	usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	timestamp: Date.now(),
});

const overflowReply = (errorMessage = "prompt is too long: 120000 tokens > 100000 maximum"): AssistantMessage => ({
	role: "assistant",
	api: "openai-completions",
	provider: "echo",
	model: "echo-1",
	content: [],
	stopReason: "error",
	errorMessage,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	timestamp: Date.now(),
});

const lengthReply = (text = "partial truncated summary..."): AssistantMessage => ({
	role: "assistant",
	api: "openai-completions",
	provider: "echo",
	model: "echo-1",
	content: [{ type: "text", text }],
	stopReason: "length",
	usage: { input: 100, output: 4096, cacheRead: 0, cacheWrite: 0, totalTokens: 4196, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	timestamp: Date.now(),
});

const promptTextOf = (ctx: Context): string => String(ctx.messages[0]?.content ?? "");

describe("nextSummaryBudget", () => {
	test("halves budget down to floor and returns null once at or below floor", () => {
		expect(nextSummaryBudget(10_000, 2_000, 0.5)).toBe(5_000);
		expect(nextSummaryBudget(5_000, 2_000, 0.5)).toBe(2_500);
		expect(nextSummaryBudget(2_500, 2_000, 0.5)).toBe(2_000);
		expect(nextSummaryBudget(2_000, 2_000, 0.5)).toBeNull();
		expect(nextSummaryBudget(500, 2_000, 0.5)).toBeNull();
		expect(nextSummaryBudget(0, 2_000, 0.5)).toBeNull();
	});

	test("handles floor + 1 and rejects invalid shrink factors", () => {
		expect(nextSummaryBudget(2_001, 2_000, 0.5)).toBe(2_000);
		expect(nextSummaryBudget(10_000, 2_000, 0)).toBeNull();
		expect(nextSummaryBudget(10_000, 2_000, 1)).toBeNull();
		expect(nextSummaryBudget(10_000, 2_000, Number.NaN)).toBeNull();
	});
});

describe("completeSummaryWithShrinkRetry", () => {
	test("recovers after one context overflow by shrinking transcript by 50%", async () => {
		const messages = makeLongMessages(12, 1500);
		const fullLen = transcript(messages).length;
		expect(fullLen).toBeGreaterThan(MIN_SUMMARY_BUDGET_CHARS * 4);

		const prompts: string[] = [];
		const retries: { attempt: number; maxRetries: number; reason: string; previousChars: number; nextChars: number }[] = [];
		const reply = await completeSummaryWithShrinkRetry(
			async (ctx) => {
				prompts.push(promptTextOf(ctx));
				if (prompts.length === 1) return overflowReply();
				return okReply("recovered summary");
			},
			{
				previousSummary: "earlier summary",
				messages,
				instructions: "keep file paths",
				contextWindow: 128_000,
				onShrinkRetry: (info) => retries.push(info),
			},
		);

		expect(reply.stopReason).toBe("stop");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
		expect(prompts[1]).toContain("[earlier part omitted]");
		expect(prompts[1]).toContain("earlier summary");
		expect(prompts[1]).toContain("keep file paths");
		expect(prompts[1]).not.toContain(CONCISE_SUMMARY_INSTRUCTION);
		expect(retries).toEqual([
			{
				attempt: 1,
				maxRetries: MAX_SUMMARY_SHRINK_RETRIES,
				reason: "context_overflow",
				previousChars: fullLen,
				nextChars: Math.floor(fullLen * 0.5),
			},
		]);
	});

	test("also recovers when context overflow is thrown as an Error", async () => {
		const messages = makeLongMessages(10, 1500);
		let calls = 0;
		const reply = await completeSummaryWithShrinkRetry(
			async () => {
				if (++calls === 1) throw new Error("This model's maximum context length is 8192 tokens");
				return okReply("recovered after throw");
			},
			{ previousSummary: null, messages, contextWindow: 8192 },
		);

		expect(reply.stopReason).toBe("stop");
		expect(calls).toBe(2);
	});

	test("stops after maxRetries consecutive context overflows and returns the last overflow reply", async () => {
		const messages = makeLongMessages(20, 1800);
		const prompts: string[] = [];
		const retries: number[] = [];

		const reply = await completeSummaryWithShrinkRetry(
			async (ctx) => {
				prompts.push(promptTextOf(ctx));
				return overflowReply();
			},
			{
				previousSummary: null,
				messages,
				maxRetries: 3,
				onShrinkRetry: (info) => retries.push(info.attempt),
			},
		);

		expect(reply.stopReason).toBe("error");
		expect(prompts).toHaveLength(4);
		expect(retries).toEqual([1, 2, 3]);
		// Each retry strictly shrinks the prompt.
		for (let i = 1; i < prompts.length; i++) {
			expect(prompts[i]!.length).toBeLessThan(prompts[i - 1]!.length);
		}
	});

	test("recovers from stopReason=length by shrinking transcript and adding concise instruction", async () => {
		const messages = makeLongMessages(12, 1500);
		const prompts: string[] = [];
		const reasons: string[] = [];

		const reply = await completeSummaryWithShrinkRetry(
			async (ctx) => {
				prompts.push(promptTextOf(ctx));
				if (prompts.length === 1) return lengthReply();
				return okReply("concise complete summary");
			},
			{
				previousSummary: null,
				messages,
				onShrinkRetry: (info) => reasons.push(info.reason),
			},
		);

		expect(reply.stopReason).toBe("stop");
		expect(prompts).toHaveLength(2);
		expect(reasons).toEqual(["output_length"]);
		expect(prompts[0]).not.toContain(CONCISE_SUMMARY_INSTRUCTION);
		expect(prompts[1]).toContain(CONCISE_SUMMARY_INSTRUCTION);
		expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
	});

	test("returns stopReason=length after retries are exhausted so caller rejects truncated summary", async () => {
		const messages = makeLongMessages(20, 1800);
		let calls = 0;

		const reply = await completeSummaryWithShrinkRetry(
			async () => {
				calls++;
				return lengthReply(`truncated-${calls}`);
			},
			{ previousSummary: null, messages, maxRetries: 2 },
		);

		expect(calls).toBe(3);
		expect(reply.stopReason).toBe("length");
	});

	test("stops immediately without retrying when transcript is already at or below minBudgetChars", async () => {
		const shortMessages = [makeUser("short message one"), makeUser("short message two")];
		expect(transcript(shortMessages).length).toBeLessThanOrEqual(MIN_SUMMARY_BUDGET_CHARS);

		let overflowCalls = 0;
		const overflowRes = await completeSummaryWithShrinkRetry(
			async () => {
				overflowCalls++;
				return overflowReply();
			},
			{ previousSummary: null, messages: shortMessages },
		);
		expect(overflowCalls).toBe(1);
		expect(overflowRes.stopReason).toBe("error");

		let lengthCalls = 0;
		const lengthRes = await completeSummaryWithShrinkRetry(
			async () => {
				lengthCalls++;
				return lengthReply();
			},
			{ previousSummary: null, messages: shortMessages },
		);
		expect(lengthCalls).toBe(1);
		expect(lengthRes.stopReason).toBe("length");
	});

	test("stops immediately when aborted before or during a retry", async () => {
		const messages = makeLongMessages(12, 1500);

		// Already aborted before first call
		const preAborted = new AbortController();
		preAborted.abort();
		let preCalls = 0;
		await expect(
			completeSummaryWithShrinkRetry(
				async () => {
					preCalls++;
					return okReply();
				},
				{ previousSummary: null, messages, signal: preAborted.signal },
			),
		).rejects.toThrow("compaction cancelled");
		expect(preCalls).toBe(0);

		// Aborted mid-flight while first attempt returns overflow
		const midAbort = new AbortController();
		let midCalls = 0;
		const midRes = await completeSummaryWithShrinkRetry(
			async () => {
				midCalls++;
				midAbort.abort();
				return overflowReply();
			},
			{ previousSummary: null, messages, signal: midAbort.signal },
		);
		expect(midCalls).toBe(1);
		expect(midRes.stopReason).toBe("error");
	});

	test("does not shrink-retry non-overflow permanent errors", async () => {
		const messages = makeLongMessages(12, 1500);
		let calls = 0;
		const res = await completeSummaryWithShrinkRetry(
			async () => {
				calls++;
				return { ...overflowReply("401 Unauthorized: invalid api key") };
			},
			{ previousSummary: null, messages },
		);
		expect(calls).toBe(1);
		expect(res.stopReason).toBe("error");
	});

	test("rethrows the original thrown overflow error when maxRetries or floor is reached", async () => {
		const longMessages = makeLongMessages(20, 1800);
		let longCalls = 0;
		await expect(
			completeSummaryWithShrinkRetry(
				async () => {
					longCalls++;
					throw new Error("prompt is too long: exceeded limit");
				},
				{ previousSummary: null, messages: longMessages, maxRetries: 2 },
			),
		).rejects.toThrow("prompt is too long: exceeded limit");
		expect(longCalls).toBe(3);

		const shortMessages = [makeUser("tiny")];
		let shortCalls = 0;
		await expect(
			completeSummaryWithShrinkRetry(
				async () => {
					shortCalls++;
					throw new Error("prompt is too long: floor");
				},
				{ previousSummary: null, messages: shortMessages },
			),
		).rejects.toThrow("prompt is too long: floor");
		expect(shortCalls).toBe(1);
	});

	test("shrinks from initialBudgetChars when transcript exceeds the initial budget", async () => {
		const messages = makeLongMessages(20, 1800);
		expect(transcript(messages).length).toBeGreaterThan(20_000);
		const retries: { previousChars: number; nextChars: number }[] = [];

		const reply = await completeSummaryWithShrinkRetry(
			async () => (retries.length === 0 ? overflowReply() : okReply()),
			{
				previousSummary: null,
				messages,
				initialBudgetChars: 10_000,
				onShrinkRetry: ({ previousChars, nextChars }) => retries.push({ previousChars, nextChars }),
			},
		);

		expect(reply.stopReason).toBe("stop");
		expect(retries).toEqual([{ previousChars: 10_000, nextChars: 5_000 }]);
	});

	test("respects maxRetries=0 and handles mixed overflow -> length -> ok sequence", async () => {
		const messages = makeLongMessages(16, 1500);
		let zeroRetryCalls = 0;
		const zeroRes = await completeSummaryWithShrinkRetry(
			async () => {
				zeroRetryCalls++;
				return overflowReply();
			},
			{ previousSummary: null, messages, maxRetries: 0 },
		);
		expect(zeroRetryCalls).toBe(1);
		expect(zeroRes.stopReason).toBe("error");

		const prompts: string[] = [];
		const reasons: string[] = [];
		const mixedRes = await completeSummaryWithShrinkRetry(
			async (ctx) => {
				prompts.push(promptTextOf(ctx));
				if (prompts.length === 1) return overflowReply();
				if (prompts.length === 2) return lengthReply();
				if (prompts.length === 3) return overflowReply();
				return okReply("done");
			},
			{
				previousSummary: null,
				messages,
				maxRetries: 3,
				onShrinkRetry: ({ reason }) => reasons.push(reason),
			},
		);
		expect(mixedRes.stopReason).toBe("stop");
		expect(reasons).toEqual(["context_overflow", "output_length", "context_overflow"]);
		expect(prompts[0]).not.toContain(CONCISE_SUMMARY_INSTRUCTION);
		expect(prompts[1]).not.toContain(CONCISE_SUMMARY_INSTRUCTION);
		expect(prompts[2]).toContain(CONCISE_SUMMARY_INSTRUCTION);
		expect(prompts[3]).toContain(CONCISE_SUMMARY_INSTRUCTION);
	});
});
