import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { recoverWithFallback, retryDroppedMidStream, type RetryNotice } from "../src/stream-runner.ts";
import { markCommittedMidStreamError } from "../src/upstream-retry.ts";

const partialError = (errorMessage: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "partial..." }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-4o",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "error",
	errorMessage,
	timestamp: Date.now(),
});

const emptyError = (errorMessage: string): AgentMessage => ({
	...partialError(errorMessage),
	content: [],
});

const okReply = (): AgentMessage => ({
	...partialError(""),
	stopReason: "stop",
	errorMessage: undefined,
	content: [{ type: "text", text: "done" }],
});

describe("retryDroppedMidStream", () => {
	test("retries transient mid-stream errors until recovery and emits notices", async () => {
		const messages: AgentMessage[] = [partialError("socket closed unexpectedly (ECONNRESET)")];
		const notices: RetryNotice[] = [];
		let drops = 0;
		let continues = 0;

		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { drops++; messages.pop(); },
			continueRun: async () => {
				continues++;
				messages.push(continues < 2 ? partialError("503 Service Unavailable") : okReply());
			},
			onRetry: (n) => notices.push(n),
			retryOpts: { maxRetries: 3, maxZeroOutputRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
		});

		expect(res).toEqual({ attempts: 2, aborted: false, forceStopped: false, error: null });
		expect(drops).toBe(2);
		expect(continues).toBe(2);
		expect(notices.map((n) => [n.attempt, n.maxRetries, n.restart])).toEqual([
			[1, 3, true],
			[2, 3, true],
		]);
	});

	test("enforces maxZeroOutputRetries cap even when maxRetries is higher", async () => {
		const messages: AgentMessage[] = [partialError("upstream stream closed with zero output")];
		const notices: RetryNotice[] = [];
		let continues = 0;

		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { messages.pop(); },
			continueRun: async () => {
				continues++;
				messages.push(partialError("upstream stream closed with zero output"));
			},
			onRetry: (n) => notices.push(n),
			retryOpts: { maxRetries: 5, maxZeroOutputRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
		});

		expect(res).toEqual({ attempts: 2, aborted: false, forceStopped: false, error: null });
		expect(continues).toBe(2);
		expect(notices.map((n) => [n.attempt, n.maxRetries])).toEqual([
			[1, 2],
			[2, 2],
		]);
	});

	test("enforces maxWarmupRetries cap for proxy startup warm-up errors", async () => {
		const warmupErr = '400: {"message":"unknown provider for model gemini-4-neon","type":"invalid_request_error","code":"model_not_found"}';
		const messages: AgentMessage[] = [partialError(warmupErr)];
		const notices: RetryNotice[] = [];
		let continues = 0;

		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { messages.pop(); },
			continueRun: async () => {
				continues++;
				messages.push(partialError(warmupErr));
			},
			onRetry: (n) => notices.push(n),
			retryOpts: { maxRetries: 5, maxWarmupRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
		});

		expect(res).toEqual({ attempts: 2, aborted: false, forceStopped: false, error: null });
		expect(continues).toBe(2);
		expect(notices.map((n) => [n.attempt, n.maxRetries])).toEqual([
			[1, 2],
			[2, 2],
		]);
	});

	test("gives unclassified errors at most a single retry", async () => {
		const messages: AgentMessage[] = [partialError("weird bespoke proxy glitch xyz")];
		let continues = 0;

		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { messages.pop(); },
			continueRun: async () => {
				continues++;
				messages.push(partialError("weird bespoke proxy glitch xyz"));
			},
			retryOpts: { maxRetries: 4, baseDelayMs: 10, maxDelayMs: 100 },
		});

		expect(res.attempts).toBe(1);
		expect(continues).toBe(1);
	});

	test("skips uncommitted empty error replies and permanent errors", async () => {
		for (const msg of [emptyError("503 Service Unavailable"), partialError("401 Unauthorized: invalid api key")]) {
			let called = false;
			const res = await retryDroppedMidStream({
				getLastMessage: () => msg,
				shouldStop: () => false,
				sleep: async () => { called = true; return { aborted: false }; },
				dropLastReply: () => { called = true; },
				continueRun: async () => { called = true; },
				retryOpts: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
			});
			expect(res).toEqual({ attempts: 0, aborted: false, forceStopped: false, error: null });
			expect(called).toBe(false);
		}
	});

	test("retries committed empty/thinking-only error replies (thinking_start -> error with empty content)", async () => {
		const committedEmpty = emptyError("503 Service Unavailable");
		markCommittedMidStreamError(committedEmpty);
		const messages: AgentMessage[] = [committedEmpty];
		const notices: RetryNotice[] = [];
		let drops = 0;
		let continues = 0;

		const res = await retryDroppedMidStream({
			getLastMessage: () => messages[messages.length - 1],
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { drops++; messages.pop(); },
			continueRun: async () => {
				continues++;
				messages.push(okReply());
			},
			onRetry: (n) => notices.push(n),
			retryOpts: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
		});

		expect(res).toEqual({ attempts: 1, aborted: false, forceStopped: false, error: null });
		expect(drops).toBe(1);
		expect(continues).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]!.restart).toBeUndefined();
		expect(messages).toHaveLength(1);
		expect((messages[0] as AssistantMessage).stopReason).toBe("stop");
	});

	test("returns aborted or forceStopped without dropping the reply when sleep is interrupted", async () => {
		let dropped = false;
		const aborted = await retryDroppedMidStream({
			getLastMessage: () => partialError("502 Bad Gateway"),
			shouldStop: () => false,
			sleep: async () => ({ aborted: true }),
			dropLastReply: () => { dropped = true; },
			continueRun: async () => { dropped = true; },
			retryOpts: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
		});
		expect(aborted).toEqual({ attempts: 0, aborted: true, forceStopped: false, error: null });
		expect(dropped).toBe(false);

		const forced = await retryDroppedMidStream({
			getLastMessage: () => partialError("502 Bad Gateway"),
			shouldStop: () => false,
			sleep: async () => ({ aborted: true, forceStopped: true }),
			dropLastReply: () => { dropped = true; },
			continueRun: async () => { dropped = true; },
			retryOpts: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
		});
		expect(forced).toEqual({ attempts: 0, aborted: false, forceStopped: true, error: null });
		expect(dropped).toBe(false);
	});

	test("captures continueRun errors when catchErrors is true and rethrows when false", async () => {
		const caught = await retryDroppedMidStream({
			getLastMessage: () => partialError("503 Service Unavailable"),
			shouldStop: () => false,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => {},
			continueRun: async () => { throw new Error("boom"); },
			retryOpts: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
			catchErrors: true,
		});
		expect(caught).toEqual({ attempts: 1, aborted: false, forceStopped: false, error: "boom" });

		await expect(
			retryDroppedMidStream({
				getLastMessage: () => partialError("503 Service Unavailable"),
				shouldStop: () => false,
				sleep: async () => ({ aborted: false }),
				dropLastReply: () => {},
				continueRun: async () => { throw new Error("boom"); },
				retryOpts: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
			}),
		).rejects.toThrow("boom");
	});
});

describe("recoverWithFallback", () => {
	test("switches to fallback on zero-output error and marks restart only when partial content exists", async () => {
		const notices: RetryNotice[] = [];
		const used: string[] = [];
		let drops = 0;

		const resEmpty = await recoverWithFallback({
			getLastMessage: () => emptyError("upstream stream closed with zero output"),
			resolveFallback: async () => ({ id: "fb-1", label: "anthropic/claude" }),
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { drops++; },
			runWithFallback: async (t) => { used.push(t.id); },
			onRetry: (n) => notices.push(n),
			delayMs: 5,
		});
		expect(resEmpty).toEqual({ attempted: true, aborted: false, forceStopped: false, error: null });
		expect(notices[0]?.restart).toBeUndefined();
		expect(notices[0]?.reason).toContain("anthropic/claude");

		const resPartial = await recoverWithFallback({
			getLastMessage: () => partialError("upstream stream closed with zero output"),
			resolveFallback: async () => ({ id: "fb-2", label: "openai/gpt-5" }),
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => { drops++; },
			runWithFallback: async (t) => { used.push(t.id); },
			onRetry: (n) => notices.push(n),
			delayMs: 5,
		});
		expect(resPartial).toEqual({ attempted: true, aborted: false, forceStopped: false, error: null });
		expect(notices[1]?.restart).toBe(true);
		expect(drops).toBe(2);
		expect(used).toEqual(["fb-1", "fb-2"]);
	});

	test("skips non-zero-output errors or when no fallback is available", async () => {
		let resolved = false;
		const nonZero = await recoverWithFallback({
			getLastMessage: () => partialError("503 Service Unavailable"),
			resolveFallback: async () => { resolved = true; return { label: "fb" }; },
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => {},
			runWithFallback: async () => {},
		});
		expect(nonZero.attempted).toBe(false);
		expect(resolved).toBe(false);

		const noTarget = await recoverWithFallback({
			getLastMessage: () => emptyError("upstream stream closed with zero output"),
			resolveFallback: async () => null,
			sleep: async () => ({ aborted: false }),
			dropLastReply: () => {},
			runWithFallback: async () => {},
		});
		expect(noTarget.attempted).toBe(false);
	});

	test("handles abort and forceStop during fallback sleep without invoking runWithFallback", async () => {
		let ran = false;
		const aborted = await recoverWithFallback({
			getLastMessage: () => emptyError("upstream stream closed with zero output"),
			resolveFallback: async () => ({ label: "fb" }),
			sleep: async () => ({ aborted: true }),
			dropLastReply: () => { ran = true; },
			runWithFallback: async () => { ran = true; },
		});
		expect(aborted).toEqual({ attempted: true, aborted: true, forceStopped: false, error: null });
		expect(ran).toBe(false);

		const forced = await recoverWithFallback({
			getLastMessage: () => emptyError("upstream stream closed with zero output"),
			resolveFallback: async () => ({ label: "fb" }),
			sleep: async () => ({ aborted: true, forceStopped: true }),
			dropLastReply: () => { ran = true; },
			runWithFallback: async () => { ran = true; },
		});
		expect(forced).toEqual({ attempted: false, aborted: false, forceStopped: true, error: null });
		expect(ran).toBe(false);
	});
});
