import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError, retryDelayMs, type AssistantMessage, type AssistantMessageEventStream, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai";

type Stream<A extends unknown[]> = (...args: A) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface UpstreamRetryOptions {
	/** Retries after the first attempt (0 = off). */
	maxRetries: number;
	/** Wait before the first retry; doubles each time (capped at maxDelayMs). */
	baseDelayMs: number;
	maxDelayMs: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorMessage: string) => void;
	/** Called once per error that is neither known transient nor known permanent (it gets a single retry). */
	onUnknown?: (errorMessage: string) => void;
}

/** 2s, 4s, 8s, 16s, 30s, 30s: about 90 seconds of patience for a gateway that drops for a moment (502/503/504, reset, timeout). */
export const DEFAULT_UPSTREAM_RETRY: UpstreamRetryOptions = { maxRetries: 6, baseDelayMs: 2000, maxDelayMs: 30_000 };

/**
 * A stream that broke after part of the reply had already been sent (a proxy or gateway closed the socket mid-answer).
 * The partial reply cannot be resumed, so the whole request is repeated: fewer tries than DEFAULT_UPSTREAM_RETRY
 * (2s, 4s, 8s) because the user is already waiting on an answer that disappeared.
 */
export const STREAM_RETRY: UpstreamRetryOptions = { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 10_000 };

/** 1s, 2s, 4s: short backoff for one-shot completions (/compact, /llm/complete, session titles). */
export const COMPLETION_RETRY: UpstreamRetryOptions = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000 };

/**
 * A short, safe reason for the "retrying" notice: one line, at most 200 characters, with URL queries/credentials,
 * bearer tokens, API keys and header-like `name: value` secrets removed. Empty when there is nothing to say.
 */
export function retryReason(message: string | undefined): string {
	let s = (message ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); // gateways answer with HTML pages
	s = s.replace(/(https?:\/\/)[^\s/@]*@/gi, "$1"); // user:pass@host
	s = s.replace(/(https?:\/\/[^\s?#"')]*)[?#][^\s"')]*/gi, "$1"); // query and fragment
	s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***");
	s = s.replace(/\b(authorization|api[-_]?key|x-api-key|token|secret|password|cookie)\b\s*["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, "$1: ***");
	s = s.replace(/\b(sk|pk|rk|key|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{12,}/g, "***");
	return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * Failures that repeating the same request cannot fix: client-side HTTP statuses, bad credentials, quota and billing,
 * policy refusals, unknown models. Checked before anything else, so "quota exceeded … 500" is still not retried.
 */
const PERMANENT_ERROR = new RegExp(
	[
		"(?<![a-z0-9.:])(?:400|401|402|403|404|405|409|410|413|415|422)(?![a-z0-9])",
		"invalid.?(?:api.?key|request|x-api-key|token|model|argument|parameter)",
		"invalid_request_error",
		"unauthori[sz]ed",
		"forbidden",
		"permission.?denied",
		"authentication",
		"(?<![a-z])not.?found", // not ENOTFOUND (DNS), which is transient
		"model .{0,60}(?:not (?:found|available|supported)|does not exist)",
		"does not exist",
		"insufficient_quota",
		"quota exceeded",
		"usage limit",
		"available balance",
		"out of budget",
		"billing",
		"credit balance",
		"refusal", // not "connection refused", which is transient
		"safeguard",
		"content.?policy",
		"flagged",
		"safety",
	].join("|"),
	"i",
);

/**
 * Raw socket and premature stream-close failures that pi-ai's retry list misses when a gateway passes them through
 * inside an SSE error event (where the SDK drops the HTTP 502 status), e.g. CLIProxyAPI's Go socket resets or
 * "upstream stream closed before any chunk carried finish_reason".
 */
const TRANSPORT_ERROR = /reset by peer|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|broken pipe|unexpected EOF|EHOSTUNREACH|ENETUNREACH|no route to host|network is unreachable|closed before (?:any chunk|finish_?reason|\[DONE\]|message_stop|first payload|start|response\.completed)/i;

/**
 * Proxy / provider zero-output terminations (e.g. CLIProxyAPI's 502 or SSE error for Gemini/Antigravity streams that
 * close with no visible output or finish with MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL / MALFORMED_RESPONSE).
 */
const ZERO_OUTPUT_ERROR = /zero output|(?:Gemini|upstream) (?:response|stream) (?:finished|closed) with (?:zero output|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|MALFORMED_RESPONSE)|finishReason (?:MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|MALFORMED_RESPONSE)/i;

/** True when the failure is a transient empty/malformed upstream generation rather than a pure network drop or permanent error. */
export const isZeroOutputError = (message: string | undefined): boolean =>
	!!message && !PERMANENT_ERROR.test(message) && ZERO_OUTPUT_ERROR.test(message);

/**
 * How a failed reply should be handled:
 * - `transient`: a gateway or provider hiccup (5xx, 429, reset, timeout, zero output …), retried with full backoff.
 * - `permanent`: will fail the same way again (4xx, auth, quota, refusal, context overflow, abort), never retried.
 * - `unknown`: anything else, e.g. a new wording from a proxy; retried once and logged so it can be classified later.
 * A reply that did not end in an error is `permanent` (there is nothing to retry).
 */
export type UpstreamErrorKind = "transient" | "permanent" | "unknown";

export function classifyUpstreamError(message: AssistantMessage): UpstreamErrorKind {
	if (message.stopReason !== "error") return "permanent";
	const text = message.errorMessage ?? "";
	if (isContextOverflow(message) || PERMANENT_ERROR.test(text)) return "permanent";
	if (isRetryableAssistantError(message) || TRANSPORT_ERROR.test(text) || ZERO_OUTPUT_ERROR.test(text)) return "transient";
	return "unknown";
}

/** True for errors worth the full retry budget. */
export const isTransientUpstreamError = (message: AssistantMessage) => classifyUpstreamError(message) === "transient";

/** Logs an unclassified upstream error (retried once) so its wording can be added to the lists above. */
export const logUnknownUpstreamError = (errorMessage: string) =>
	console.warn(`[upstream-retry] unclassified upstream error, retrying once: ${retryReason(errorMessage) || "(no message)"}`);

export const sleepAbortable = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
		signal?.addEventListener("abort", done, { once: true });
	});

function tailContentLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const part of content) if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") n += (part as { text: string }).text.length;
	return n;
}

function contextTailKey(ctx: unknown): string {
	const messages = ctx && typeof ctx === "object" ? (ctx as { messages?: unknown }).messages : undefined;
	if (!Array.isArray(messages) || messages.length === 0) return "";
	const last = messages[messages.length - 1] as { role?: unknown; timestamp?: unknown; toolCallId?: unknown; content?: unknown } | undefined;
	if (!last || typeof last !== "object") return `${messages.length}`;
	return `${messages.length}:${String(last.role ?? "")}:${String(last.timestamp ?? "")}:${String(last.toolCallId ?? "")}:${tailContentLength(last.content)}`;
}

/**
 * Appends an ephemeral retry hint to a shallow copy of the trailing `user` or `toolResult` message after repeated
 * zero-output failures on the exact same transcript tail. The earlier prefix stays byte-identical (preserving prompt
 * cache hits on 300k+ contexts), while varying the tail breaks deterministic empty-candidate / malformed-call loops.
 */
export function nudgeZeroOutputContext<C>(ctx: C, attempt: number): C {
	if (!ctx || typeof ctx !== "object") return ctx;
	const messages = (ctx as { messages?: unknown }).messages;
	if (!Array.isArray(messages) || messages.length === 0) return ctx;
	const last = messages[messages.length - 1] as { role?: string; content?: unknown } | undefined;
	if (!last || (last.role !== "user" && last.role !== "toolResult")) return ctx;
	const note = `[pipaya] Upstream closed the previous attempt with zero output (retry ${attempt}); continue with your reply or tool call.`;
	let nextLast: unknown;
	if (typeof last.content === "string") {
		nextLast = { ...last, content: `${last.content}\n\n${note}` };
	} else if (Array.isArray(last.content)) {
		nextLast = { ...last, content: [...last.content, { type: "text" as const, text: note }] };
	} else {
		return ctx;
	}
	return { ...(ctx as object), messages: [...messages.slice(0, -1), nextLast] } as C;
}

/**
 * Wraps a model stream so a transient upstream failure (502 Bad Gateway, 503, 504, connection reset, timeout, zero output …)
 * that happens before the model produced any content is retried with exponential backoff instead of ending the run.
 * Once content has streamed, an error is passed through as is: the caller owns the reply by then (SessionManager and
 * subagent delegate drop the partial message and repeat the request — see STREAM_RETRY).
 * Quota/billing errors and aborts are never retried; an unclassified error gets one retry (see classifyUpstreamError).
 */
export function withUpstreamRetry<A extends [unknown, unknown, { signal?: AbortSignal }?]>(inner: Stream<A>, opts: UpstreamRetryOptions = DEFAULT_UPSTREAM_RETRY): Stream<A> {
	const wait = opts.sleep ?? sleepAbortable;
	let tailKey = "";
	let zeroOutputStreak = 0;
	return (...args: A) => {
		const signal = args[2]?.signal;
		const key = contextTailKey(args[1]);
		if (key !== tailKey) {
			tailKey = key;
			zeroOutputStreak = 0;
		}
		const out = createAssistantMessageEventStream();
		void (async () => {
			let attempt = 0;
			let unknownUsed = false;
			// Worth another try: transient errors while the budget lasts, an unclassified one only once per call.
			const retryable = (m: AssistantMessage) => {
				if (attempt >= opts.maxRetries || signal?.aborted) return undefined;
				const kind = classifyUpstreamError(m);
				return kind === "transient" || (kind === "unknown" && !unknownUsed) ? kind : undefined;
			};
			for (;;) {
				let kind: UpstreamErrorKind | undefined;
				const pending: AssistantMessageEvent[] = [];
				let committed = false;
				let failure: AssistantMessage | undefined;
				const callArgs = (zeroOutputStreak >= 2 ? [args[0], nudgeZeroOutputContext(args[1], zeroOutputStreak), ...args.slice(2)] : args) as A;
				try {
					const stream = await inner(...callArgs);
					for await (const ev of stream) {
						if (ev.type === "done") zeroOutputStreak = 0;
						else if (ev.type === "error") zeroOutputStreak = ev.reason === "error" && isZeroOutputError(ev.error.errorMessage) ? zeroOutputStreak + 1 : 0;
						if (committed) { out.push(ev); continue; }
						if (ev.type === "start") { pending.push(ev); continue; }
						if (ev.type === "error" && ev.reason === "error" && (kind = retryable(ev.error))) {
							failure = ev.error;
							break;
						}
						committed = true;
						for (const p of pending) out.push(p);
						out.push(ev);
					}
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					zeroOutputStreak = isZeroOutputError(message) ? zeroOutputStreak + 1 : 0;
					// A thrown error before any content is the same transient failure; after content, surface it.
					if (committed) throw e;
					const probe = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
					if (!(kind = retryable(probe))) throw e;
					failure = probe;
				}
				if (!failure) return out.end();
				attempt++;
				if (kind === "unknown") {
					unknownUsed = true;
					(opts.onUnknown ?? logUnknownUpstreamError)(failure.errorMessage ?? "");
				}
				// An unclassified error waits the shortest step and is announced as the last try.
				const delay = kind === "unknown" ? opts.baseDelayMs : retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
				opts.onRetry?.(attempt, kind === "unknown" ? attempt : opts.maxRetries, delay, failure.errorMessage ?? "");
				await wait(delay, signal);
				if (signal?.aborted) {
					// Cancelled while waiting: report it like any other abort.
					const { errorMessage: _drop, ...rest } = failure;
					const aborted = { ...rest, stopReason: "aborted" } as AssistantMessage;
					out.push({ type: "error", reason: "aborted", error: aborted });
					return out.end(aborted);
				}
			}
		})().catch((e) => {
			const message = e instanceof Error ? e.message : String(e);
			const error = { role: "assistant", content: [], stopReason: "error", errorMessage: message, timestamp: Date.now() } as unknown as AssistantMessage;
			out.push({ type: "error", reason: "error", error });
			out.end(error);
		});
		return out;
	};
}

/**
 * Retries a one-shot `completeSimple` call on known transient upstream errors (502/503/504, socket reset, zero output).
 * Permanent and unknown errors return immediately so deterministic failures and mocks do not block one-shot endpoints.
 */
export async function completeWithUpstreamRetry(
	inner: (ctx: Context) => Promise<AssistantMessage>,
	ctx: Context,
	opts: UpstreamRetryOptions = COMPLETION_RETRY,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const wait = opts.sleep ?? sleepAbortable;
	let attempt = 0;
	let zeroOutputStreak = 0;
	for (;;) {
		const callCtx = zeroOutputStreak >= 2 ? nudgeZeroOutputContext(ctx, zeroOutputStreak) : ctx;
		let reply: AssistantMessage;
		try {
			reply = await inner(callCtx);
		} catch (e) {
			if (signal?.aborted || attempt >= opts.maxRetries) throw e;
			const message = e instanceof Error ? e.message : String(e);
			const probe = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
			if (classifyUpstreamError(probe) !== "transient") throw e;
			zeroOutputStreak = isZeroOutputError(message) ? zeroOutputStreak + 1 : 0;
			attempt++;
			const delay = retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
			opts.onRetry?.(attempt, opts.maxRetries, delay, message);
			await wait(delay, signal);
			if (signal?.aborted) throw e;
			continue;
		}
		if (reply.stopReason !== "error" || signal?.aborted || attempt >= opts.maxRetries || classifyUpstreamError(reply) !== "transient") {
			return reply;
		}
		zeroOutputStreak = isZeroOutputError(reply.errorMessage) ? zeroOutputStreak + 1 : 0;
		attempt++;
		const delay = retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
		opts.onRetry?.(attempt, opts.maxRetries, delay, reply.errorMessage ?? "");
		await wait(delay, signal);
		if (signal?.aborted) {
			const { errorMessage: _drop, ...rest } = reply;
			return { ...rest, stopReason: "aborted" } as AssistantMessage;
		}
	}
}
