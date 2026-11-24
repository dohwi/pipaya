import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { retryDelayMs } from "@earendil-works/pi-ai";
import { classifyUpstreamError, isZeroOutputError, logUnknownUpstreamError, retryReason, STREAM_RETRY, type UpstreamRetryOptions } from "./upstream-retry.ts";

export interface RetrySleepResult {
	aborted: boolean;
	forceStopped?: boolean;
}

export interface RetryNotice {
	attempt: number;
	maxRetries: number;
	delayMs: number;
	restart?: true;
	reason?: string;
}

export interface MidStreamRetryOptions {
	getLastMessage: () => AgentMessage | undefined;
	shouldStop: () => boolean;
	sleep: (delayMs: number) => Promise<RetrySleepResult>;
	dropLastReply: () => void;
	continueRun: () => Promise<void>;
	onRetry?: (notice: RetryNotice) => void;
	retryOpts?: UpstreamRetryOptions;
	catchErrors?: boolean;
}

export interface MidStreamRetryResult {
	attempts: number;
	aborted: boolean;
	forceStopped: boolean;
	error: string | null;
}

/**
 * Repeats a turn that terminated with a retryable error *after* partial output had already streamed.
 * Empty replies are handled upstream by `withUpstreamRetry`; partial replies cannot be resumed in place,
 * so each attempt drops the half-written assistant message and calls `continueRun()`.
 */
export async function retryDroppedMidStream(opts: MidStreamRetryOptions): Promise<MidStreamRetryResult> {
	const cfg = opts.retryOpts ?? STREAM_RETRY;
	const zeroCap = cfg.maxZeroOutputRetries !== undefined ? Math.min(cfg.maxRetries, cfg.maxZeroOutputRetries) : cfg.maxRetries;
	let attempts = 0;

	for (let attempt = 1, unknownUsed = false; !opts.shouldStop() && attempt <= cfg.maxRetries; attempt++) {
		const last = opts.getLastMessage();
		if (last?.role !== "assistant" || last.stopReason !== "error" || !last.content.length) break;
		const kind = classifyUpstreamError(last);
		if (kind === "permanent" || (kind === "unknown" && unknownUsed)) break;

		const zero = isZeroOutputError(last.errorMessage);
		if (zero && attempt > zeroCap) break;

		let maxRetries = zero ? zeroCap : cfg.maxRetries;
		if (kind === "unknown") {
			unknownUsed = true;
			maxRetries = attempt;
			logUnknownUpstreamError(last.errorMessage ?? "");
		}
		const delayMs = kind === "unknown" ? cfg.baseDelayMs : retryDelayMs({ baseDelayMs: cfg.baseDelayMs, maxAgentDelayMs: cfg.maxDelayMs }, attempt);
		const reason = retryReason(last.errorMessage);
		opts.onRetry?.({ attempt, maxRetries, delayMs, restart: true, ...(reason ? { reason } : {}) });

		const waited = await opts.sleep(delayMs);
		if (waited.forceStopped) return { attempts, aborted: false, forceStopped: true, error: null };
		if (waited.aborted) return { attempts, aborted: true, forceStopped: false, error: null };

		opts.dropLastReply();
		attempts = attempt;
		try {
			await opts.continueRun();
		} catch (e) {
			if (!opts.catchErrors) throw e;
			return { attempts, aborted: false, forceStopped: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	return { attempts, aborted: false, forceStopped: false, error: null };
}

export interface FallbackRecoveryOptions<T extends { label: string }> {
	getLastMessage: () => AgentMessage | undefined;
	resolveFallback: () => Promise<T | null>;
	sleep: (delayMs: number) => Promise<RetrySleepResult>;
	dropLastReply: () => void;
	runWithFallback: (target: T) => Promise<void>;
	onRetry?: (notice: RetryNotice) => void;
	delayMs?: number;
	catchErrors?: boolean;
}

export interface FallbackRecoveryResult {
	attempted: boolean;
	aborted: boolean;
	forceStopped: boolean;
	error: string | null;
}

/**
 * When the primary model terminates with a zero-output error even after upstream retries,
 * drops the failed reply and retries the turn on a resolved fallback model.
 */
export async function recoverWithFallback<T extends { label: string }>(opts: FallbackRecoveryOptions<T>): Promise<FallbackRecoveryResult> {
	const last = opts.getLastMessage();
	if (last?.role !== "assistant" || last.stopReason !== "error" || !isZeroOutputError(last.errorMessage)) {
		return { attempted: false, aborted: false, forceStopped: false, error: null };
	}
	const target = await opts.resolveFallback();
	if (!target) return { attempted: false, aborted: false, forceStopped: false, error: null };

	const delayMs = opts.delayMs ?? 1000;
	const reason = retryReason(`${last.errorMessage ?? "zero output"} → ${target.label}`);
	opts.onRetry?.({ attempt: 1, maxRetries: 1, delayMs, ...(last.content.length ? { restart: true } : {}), ...(reason ? { reason } : {}) });

	const waited = await opts.sleep(delayMs);
	if (waited.forceStopped) return { attempted: false, aborted: false, forceStopped: true, error: null };
	if (waited.aborted) return { attempted: true, aborted: true, forceStopped: false, error: null };

	opts.dropLastReply();
	try {
		await opts.runWithFallback(target);
	} catch (e) {
		if (!opts.catchErrors) throw e;
		return { attempted: true, aborted: false, forceStopped: false, error: e instanceof Error ? e.message : String(e) };
	}
	return { attempted: true, aborted: false, forceStopped: false, error: null };
}
