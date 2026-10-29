import { createAssistantMessageEventStream, isRetryableAssistantError, retryDelayMs, type AssistantMessage, type AssistantMessageEventStream, type AssistantMessageEvent } from "@earendil-works/pi-ai";

type Stream<A extends unknown[]> = (...args: A) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface UpstreamRetryOptions {
	/** Retries after the first attempt (0 = off). */
	maxRetries: number;
	/** Wait before the first retry; doubles each time (capped at maxDelayMs). */
	baseDelayMs: number;
	maxDelayMs: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onRetry?: (attempt: number, maxRetries: number, delayMs: number, errorMessage: string) => void;
}

/** 2s, 4s, 8s, 16s, 30s, 30s: about 90 seconds of patience for a gateway that drops for a moment (502/503/504, reset, timeout). */
export const DEFAULT_UPSTREAM_RETRY: UpstreamRetryOptions = { maxRetries: 6, baseDelayMs: 2000, maxDelayMs: 30_000 };

const sleepAbortable = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
		signal?.addEventListener("abort", done, { once: true });
	});

/**
 * Wraps a model stream so a transient upstream failure (502 Bad Gateway, 503, 504, connection reset, timeout …) that
 * happens before the model produced any content is retried with exponential backoff instead of ending the run.
 * Once content has streamed, an error is passed through as is: resending would duplicate what the user already saw.
 * Quota/billing errors and aborts are never retried.
 */
export function withUpstreamRetry<A extends [unknown, unknown, { signal?: AbortSignal }?]>(inner: Stream<A>, opts: UpstreamRetryOptions = DEFAULT_UPSTREAM_RETRY): Stream<A> {
	const wait = opts.sleep ?? sleepAbortable;
	return (...args: A) => {
		const signal = args[2]?.signal;
		const out = createAssistantMessageEventStream();
		void (async () => {
			let attempt = 0;
			for (;;) {
				const pending: AssistantMessageEvent[] = [];
				let committed = false;
				let failure: AssistantMessage | undefined;
				try {
					const stream = await inner(...args);
					for await (const ev of stream) {
						if (committed) { out.push(ev); continue; }
						if (ev.type === "start") { pending.push(ev); continue; }
						if (ev.type === "error" && ev.reason === "error" && isRetryableAssistantError(ev.error) && attempt < opts.maxRetries && !signal?.aborted) {
							failure = ev.error;
							break;
						}
						committed = true;
						for (const p of pending) out.push(p);
						out.push(ev);
					}
				} catch (e) {
					// A thrown error before any content is the same transient failure; after content, surface it.
					if (committed) throw e;
					const message = e instanceof Error ? e.message : String(e);
					const probe = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
					if (!isRetryableAssistantError(probe) || attempt >= opts.maxRetries || signal?.aborted) throw e;
					failure = probe;
				}
				if (!failure) return out.end();
				attempt++;
				const delay = retryDelayMs({ baseDelayMs: opts.baseDelayMs, maxAgentDelayMs: opts.maxDelayMs }, attempt);
				opts.onRetry?.(attempt, opts.maxRetries, delay, failure.errorMessage ?? "");
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
