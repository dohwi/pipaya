import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError, retryDelayMs, type AssistantMessage, type AssistantMessageEventStream, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai";

type Stream<A extends unknown[]> = (...args: A) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface UpstreamRetryOptions {
	/** Retries after the first attempt (0 = off). */
	maxRetries: number;
	/** Cap on consecutive zero-output retries on the same model/context (defaults to `maxRetries`). */
	maxZeroOutputRetries?: number;
	/** Cap on proxy/gateway warm-up retries such as CLIProxyAPI's startup "unknown provider for model" 400 (defaults to `maxRetries`). */
	maxWarmupRetries?: number;
	/** Wait before the first retry; doubles each time (capped at maxDelayMs). */
	baseDelayMs: number;
	maxDelayMs: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorMessage: string) => void;
	/** Called once per error that is neither known transient nor known permanent (it gets a single retry). */
	onUnknown?: (errorMessage: string) => void;
}

/**
 * 2s, 4s, 8s, 16s, 30s, 30s: about 90 seconds of patience for a gateway that drops for a moment (502/503/504, reset, timeout).
 * Zero-output failures are capped at 2 retries (2s, 4s) because deterministic empty generations waste ~10-18s per attempt.
 * Proxy warm-up errors (e.g. CLIProxyAPI returning 400 "unknown provider for model" right after restart) are capped at 4 retries (~30s)
 * so restarts recover seamlessly while genuinely misconfigured models still fail fast.
 */
export const DEFAULT_UPSTREAM_RETRY: UpstreamRetryOptions = { maxRetries: 6, maxZeroOutputRetries: 2, maxWarmupRetries: 4, baseDelayMs: 2000, maxDelayMs: 30_000 };

/**
 * A stream that broke after part of the reply had already been sent (a proxy or gateway closed the socket mid-answer).
 * The partial reply cannot be resumed, so the whole request is repeated: fewer tries than DEFAULT_UPSTREAM_RETRY
 * (2s, 4s, 8s) because the user is already waiting on an answer that disappeared.
 */
export const STREAM_RETRY: UpstreamRetryOptions = { maxRetries: 3, maxZeroOutputRetries: 2, maxWarmupRetries: 3, baseDelayMs: 2000, maxDelayMs: 10_000 };

/** 1s, 2s, 4s: short backoff for one-shot completions (/compact, /llm/complete, session titles). */
export const COMPLETION_RETRY: UpstreamRetryOptions = { maxRetries: 3, maxZeroOutputRetries: 2, maxWarmupRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000 };

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

/**
 * Gateway/proxy startup warm-up error: right after a restart (e.g. CLIProxyAPI), the HTTP listener accepts
 * requests before auth/provider registries finish loading and responds with 400 invalid_request_error /
 * model_not_found ("unknown provider for model …"). Checked before PERMANENT_ERROR and capped by maxWarmupRetries
 * so genuinely misconfigured models still fail fast.
 */
const PROXY_WARMUP_ERROR = /\bunknown provider for model\b/i;

/** True when the failure is a transient empty/malformed upstream generation rather than a pure network drop or permanent error. */
export const isZeroOutputError = (message: string | undefined): boolean =>
	!!message && !PERMANENT_ERROR.test(message) && ZERO_OUTPUT_ERROR.test(message);

/** True when the failure matches a gateway/proxy startup warm-up response rather than a permanent 4xx. */
export const isProxyWarmupError = (message: string | undefined): boolean =>
	!!message && PROXY_WARMUP_ERROR.test(message);

/**
 * How a failed reply should be handled:
 * - `transient`: a gateway or provider hiccup (5xx, 429, reset, timeout, zero output, proxy warm-up …), retried with backoff.
 * - `permanent`: will fail the same way again (4xx, auth, quota, refusal, context overflow, abort), never retried.
 * - `unknown`: anything else, e.g. a new wording from a proxy; retried once and logged so it can be classified later.
 * A reply that did not end in an error is `permanent` (there is nothing to retry).
 */
export type UpstreamErrorKind = "transient" | "permanent" | "unknown";

export function classifyUpstreamError(message: AssistantMessage): UpstreamErrorKind {
	if (message.stopReason !== "error") return "permanent";
	const text = message.errorMessage ?? "";
	if (isContextOverflow(message)) return "permanent";
	if (PROXY_WARMUP_ERROR.test(text)) return "transient";
	if (PERMANENT_ERROR.test(text)) return "permanent";
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

function modelKey(model: unknown): string {
	if (!model || typeof model !== "object") return "";
	const m = model as { provider?: unknown; id?: unknown };
	return `${String(m.provider ?? "")}:${String(m.id ?? "")}`;
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

/** Tracks error messages that arrived *after* `withUpstreamRetry` committed the stream (e.g. after `thinking_start`), even when `content` is empty. */
const committedStreamErrors = new WeakSet<object>();

export function markCommittedMidStreamError(message: object): void {
	committedStreamErrors.add(message);
}

export function isCommittedMidStreamError(message: unknown): boolean {
	return !!message && typeof message === "object" && committedStreamErrors.has(message);
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
	let currentModelKey = "";
	let zeroOutputStreak = 0;
	return (...args: A) => {
		const signal = args[2]?.signal;
		const key = contextTailKey(args[1]);
		const mKey = modelKey(args[0]);
		if (key !== tailKey || mKey !== currentModelKey) {
			tailKey = key;
			currentModelKey = mKey;
			zeroOutputStreak = 0;
		}
		const out = createAssistantMessageEventStream();
		void (async () => {
			let attempt = 0;
			let warmupAttempts = 0;
			let unknownUsed = false;
			const zeroCap = opts.maxZeroOutputRetries !== undefined ? Math.min(opts.maxRetries, opts.maxZeroOutputRetries) : opts.maxRetries;
			const warmupCap = opts.maxWarmupRetries !== undefined ? Math.min(opts.maxRetries, opts.maxWarmupRetries) : opts.maxRetries;
			// Worth another try: transient errors while the budget lasts, an unclassified one only once per call.
			const retryable = (m: AssistantMessage) => {
				if (attempt >= opts.maxRetries || signal?.aborted) return undefined;
				const kind = classifyUpstreamError(m);
				if (kind === "transient") {
					if (isZeroOutputError(m.errorMessage) && attempt >= zeroCap) return undefined;
					if (isProxyWarmupError(m.errorMessage) && warmupAttempts >= warmupCap) return undefined;
					return kind;
				}
				return kind === "unknown" && !unknownUsed ? kind : undefined;
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
						if (committed) {
							if (ev.type === "error" && ev.reason === "error" && ev.error && typeof ev.error === "object") markCommittedMidStreamError(ev.error);
							out.push(ev);
							continue;
						}
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
				const warmup = isProxyWarmupError(failure.errorMessage);
				if (warmup) warmupAttempts++;
				if (kind === "unknown") {
					unknownUsed = true;
					(opts.onUnknown ?? logUnknownUpstreamError)(failure.errorMessage ?? "");
				}
				// An unclassified error waits the shortest step and is announced as the last try.
				const maxAnnounced = kind === "unknown"
					? attempt
					: isZeroOutputError(failure.errorMessage) && opts.maxZeroOutputRetries !== undefined
						? zeroCap
						: warmup && opts.maxWarmupRetries !== undefined
							? Math.min(opts.maxRetries, attempt + (warmupCap - warmupAttempts))
							: opts.maxRetries;
				const delay = kind === "unknown" ? opts.baseDelayMs : retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
				opts.onRetry?.(attempt, maxAnnounced, delay, failure.errorMessage ?? "");
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
 * Retries a one-shot `completeSimple` call on known transient upstream errors (502/503/504, socket reset, zero output, proxy warm-up)
 * and gives an unclassified ("unknown") error a single retry (matching `withUpstreamRetry`).
 * Permanent errors return immediately.
 */
export async function completeWithUpstreamRetry(
	inner: (ctx: Context) => Promise<AssistantMessage>,
	ctx: Context,
	opts: UpstreamRetryOptions = COMPLETION_RETRY,
	signal?: AbortSignal,
	onRetry?: UpstreamRetryOptions["onRetry"],
): Promise<AssistantMessage> {
	const wait = opts.sleep ?? sleepAbortable;
	const notifyRetry = onRetry ?? opts.onRetry;
	const zeroCap = opts.maxZeroOutputRetries !== undefined ? Math.min(opts.maxRetries, opts.maxZeroOutputRetries) : opts.maxRetries;
	const warmupCap = opts.maxWarmupRetries !== undefined ? Math.min(opts.maxRetries, opts.maxWarmupRetries) : opts.maxRetries;
	let attempt = 0;
	let warmupAttempts = 0;
	let zeroOutputStreak = 0;
	let unknownUsed = false;
	for (;;) {
		const callCtx = zeroOutputStreak >= 2 ? nudgeZeroOutputContext(ctx, zeroOutputStreak) : ctx;
		let reply: AssistantMessage;
		try {
			reply = await inner(callCtx);
		} catch (e) {
			if (signal?.aborted || attempt >= opts.maxRetries) throw e;
			const message = e instanceof Error ? e.message : String(e);
			const probe = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
			const kind = classifyUpstreamError(probe);
			if (kind === "permanent" || (kind === "unknown" && unknownUsed)) throw e;
			const zero = kind === "transient" && isZeroOutputError(message);
			if (zero && attempt >= zeroCap) throw e;
			const warmup = kind === "transient" && isProxyWarmupError(message);
			if (warmup && warmupAttempts >= warmupCap) throw e;
			zeroOutputStreak = zero ? zeroOutputStreak + 1 : 0;
			attempt++;
			if (warmup) warmupAttempts++;
			if (kind === "unknown") {
				unknownUsed = true;
				(opts.onUnknown ?? logUnknownUpstreamError)(message);
			}
			const maxAnnounced = kind === "unknown"
				? attempt
				: zero && opts.maxZeroOutputRetries !== undefined
					? zeroCap
					: warmup && opts.maxWarmupRetries !== undefined
						? Math.min(opts.maxRetries, attempt + (warmupCap - warmupAttempts))
						: opts.maxRetries;
			const delay = kind === "unknown" ? opts.baseDelayMs : retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
			notifyRetry?.(attempt, maxAnnounced, delay, message);
			await wait(delay, signal);
			if (signal?.aborted) throw e;
			continue;
		}
		if (reply.stopReason !== "error" || signal?.aborted || attempt >= opts.maxRetries) {
			return reply;
		}
		const kind = classifyUpstreamError(reply);
		if (kind === "permanent" || (kind === "unknown" && unknownUsed)) {
			return reply;
		}
		const zero = kind === "transient" && isZeroOutputError(reply.errorMessage);
		if (zero && attempt >= zeroCap) return reply;
		const warmup = kind === "transient" && isProxyWarmupError(reply.errorMessage);
		if (warmup && warmupAttempts >= warmupCap) return reply;
		zeroOutputStreak = zero ? zeroOutputStreak + 1 : 0;
		attempt++;
		if (warmup) warmupAttempts++;
		if (kind === "unknown") {
			unknownUsed = true;
			(opts.onUnknown ?? logUnknownUpstreamError)(reply.errorMessage ?? "");
		}
		const maxAnnounced = kind === "unknown"
			? attempt
			: zero && opts.maxZeroOutputRetries !== undefined
				? zeroCap
				: warmup && opts.maxWarmupRetries !== undefined
					? Math.min(opts.maxRetries, attempt + (warmupCap - warmupAttempts))
					: opts.maxRetries;
		const delay = kind === "unknown" ? opts.baseDelayMs : retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
		notifyRetry?.(attempt, maxAnnounced, delay, reply.errorMessage ?? "");
		await wait(delay, signal);
		if (signal?.aborted) {
			const { errorMessage: _drop, ...rest } = reply;
			return { ...rest, stopReason: "aborted" } as AssistantMessage;
		}
	}
}
