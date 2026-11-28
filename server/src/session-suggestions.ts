import { reasoningOption, type ModelRegistry } from "./models.ts";
import type { SessionStore } from "./store.ts";
import {
	FOLLOW_UP_MAX_TOKENS,
	FOLLOW_UP_SYSTEM,
	followUpRequest,
	parseFollowUpSuggestions,
	type SystemModelSettings,
} from "./system-model.ts";
import { COMPLETION_RETRY, completeWithUpstreamRetry } from "./upstream-retry.ts";

/** A failed suggestion call backs off briefly so a broken system model is not hit on every turn. */
export const SUGGEST_RETRY_MS = 2 * 60_000;
/** How many trailing stored messages we scan to extract the latest user prompt and assistant reply. */
const TURN_SCAN_LIMIT = 24;

export interface FollowUpSuggestionsPayload {
	afterSeq: number;
	suggestions: string[];
}

export interface SessionSuggesterDeps {
	store: SessionStore;
	registry: ModelRegistry;
	systemModel?: SystemModelSettings;
	isClosing: () => boolean;
	isSessionIdle: (id: string) => boolean;
	hasPendingQuestions: (id: string) => boolean;
	publish: (sessionId: string, payload: FollowUpSuggestionsPayload) => void;
}

function extractUserText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const c = (message as { content?: unknown }).content;
	if (typeof c === "string") {
		const cleaned = c.replace(/<pipaya-hint>[\s\S]*?<\/pipaya-hint>/g, "").trim();
		return cleaned && !cleaned.startsWith("<pipaya-") ? cleaned : "";
	}
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const part of c as { type?: string; text?: string }[]) {
		if (part.type !== "text" || !part.text) continue;
		const trimmed = part.text.trim();
		if (!trimmed || trimmed.startsWith("<pipaya-")) continue;
		const cleaned = trimmed.replace(/<pipaya-hint>[\s\S]*?<\/pipaya-hint>/g, "").trim();
		if (cleaned) parts.push(cleaned);
	}
	return parts.join("\n").trim();
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const c = (message as { content?: unknown }).content;
	if (typeof c === "string") return c.trim();
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const part of c as { type?: string; text?: string }[]) {
		if (part.type === "text" && part.text?.trim()) parts.push(part.text.trim());
	}
	return parts.join("\n\n").trim();
}

/**
 * Background follow-up prompt suggester using the configured system model.
 * Runs after a completed user turn when `followUpSuggestions` is enabled, keeps results strictly ephemeral in memory
 * keyed to the latest persisted message sequence, and cancels/discards stale work whenever the session moves on.
 */
export class SessionSuggester {
	private generating = new Map<string, AbortController>();
	private cache = new Map<string, FollowUpSuggestionsPayload>();
	private failedAt = new Map<string, number>();
	private pending = new Set<Promise<void>>();

	constructor(private deps: SessionSuggesterDeps) {}

	/** Returns cached suggestions for `id` only if they still match `latestSeq` and the task is enabled. */
	get(id: string, latestSeq: number): string[] {
		if (!this.deps.systemModel?.resolveFor("followUpSuggestions")) return [];
		const entry = this.cache.get(id);
		if (!entry || entry.afterSeq !== latestSeq) return [];
		return [...entry.suggestions];
	}

	/**
	 * Asks the system model for 2-3 likely follow-up prompts based on the latest user prompt and assistant reply.
	 * Never throws or fails the session; stale or aborted runs are silently discarded.
	 */
	generate(id: string, afterSeq: number): Promise<void> | undefined {
		const target = this.deps.systemModel?.resolveFor("followUpSuggestions");
		if (!target || this.deps.isClosing() || afterSeq < 0) return;
		const record = this.deps.store.get(id);
		if (!record || record.closed) return;
		if (Date.now() - (this.failedAt.get(id) ?? 0) < SUGGEST_RETRY_MS) return;

		const pair = this.latestExchange(id);
		if (!pair) return;

		this.generating.get(id)?.abort();
		this.cache.delete(id);

		const controller = new AbortController();
		this.generating.set(id, controller);

		const job = (async () => {
			try {
				const model = this.deps.registry.models.getModel(target.provider, target.model);
				if (!model || !(await this.deps.registry.models.checkAuth(target.provider))) throw new Error("system model unavailable");
				const opts = { maxTokens: FOLLOW_UP_MAX_TOKENS, signal: controller.signal, ...reasoningOption(target.thinkingLevel, model) };
				const ctx = {
					systemPrompt: FOLLOW_UP_SYSTEM,
					messages: [{ role: "user" as const, content: followUpRequest(pair), timestamp: Date.now() }],
				};
				const reply = await completeWithUpstreamRetry(
					(c) => this.deps.registry.models.completeSimple(model, c, opts),
					ctx,
					COMPLETION_RETRY,
					controller.signal,
				);
				if (controller.signal.aborted || this.deps.isClosing()) return;
				if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);

				const raw = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
				const suggestions = parseFollowUpSuggestions(raw);
				this.failedAt.delete(id);
				if (suggestions.length === 0) return;

				if (!this.deps.systemModel?.resolveFor("followUpSuggestions")) return;
				const current = this.deps.store.get(id);
				if (!current || current.closed) return;
				if (!this.deps.isSessionIdle(id) || this.deps.hasPendingQuestions(id)) return;
				if (this.deps.store.nextSeq(id) - 1 !== afterSeq) return;

				const payload: FollowUpSuggestionsPayload = { afterSeq, suggestions };
				this.cache.set(id, payload);
				this.deps.publish(id, payload);
			} catch {
				if (!controller.signal.aborted) this.failedAt.set(id, Date.now());
			} finally {
				if (this.generating.get(id) === controller) this.generating.delete(id);
			}
		})();

		this.pending.add(job);
		void job.finally(() => this.pending.delete(job));
		return job;
	}

	/** Cancels any in-flight suggestion job for `id` and drops its cached suggestions. */
	clear(id: string, options?: { forgetBackoff?: boolean; notify?: boolean }): void {
		this.generating.get(id)?.abort();
		this.generating.delete(id);
		const had = this.cache.delete(id);
		if (options?.forgetBackoff) this.failedAt.delete(id);
		if (had && options?.notify) this.deps.publish(id, { afterSeq: -1, suggestions: [] });
	}

	/** Cancels every in-flight suggestion job, clears all caches, and notifies clients whose sessions had suggestions. */
	clearAll(): void {
		for (const c of this.generating.values()) c.abort();
		this.generating.clear();
		const ids = [...this.cache.keys()];
		this.cache.clear();
		for (const id of ids) this.deps.publish(id, { afterSeq: -1, suggestions: [] });
	}

	resetBackoff(): void {
		this.failedAt.clear();
	}

	abortAll(): void {
		for (const c of this.generating.values()) c.abort();
		this.generating.clear();
		this.cache.clear();
	}

	pruneFailed(now: number): void {
		for (const [id, at] of this.failedAt) {
			if (now - at >= SUGGEST_RETRY_MS) this.failedAt.delete(id);
		}
	}

	hasPending(): boolean {
		return this.pending.size > 0;
	}

	pendingJobs(): Promise<void>[] {
		return [...this.pending];
	}

	private latestExchange(id: string): { userPrompt: string; assistantReply: string } | null {
		const rows = this.deps.store.lastMessages(id, TURN_SCAN_LIMIT);
		let assistantReply = "";
		let assistantIdx = -1;
		for (let i = rows.length - 1; i >= 0; i--) {
			const msg = rows[i]!.message as { role?: string; stopReason?: string };
			if (msg.role === "user") break;
			if (msg.role === "assistant") {
				const text = extractAssistantText(msg);
				if (text) {
					assistantReply = text;
					assistantIdx = i;
					break;
				}
			}
		}
		if (!assistantReply || assistantIdx < 0) return null;
		let userPrompt = "";
		for (let i = assistantIdx - 1; i >= 0; i--) {
			const msg = rows[i]!.message as { role?: string };
			if (msg.role === "user") {
				userPrompt = extractUserText(msg);
				if (userPrompt) break;
			}
		}
		return { userPrompt, assistantReply };
	}
}
