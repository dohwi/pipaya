import { reasoningOption, type ModelRegistry } from "./models.ts";
import type { SessionPatch, SessionStore } from "./store.ts";
import { autoTitle, DESCRIBE_MAX_TOKENS, DESCRIBE_SYSTEM, describeRequest, parseDescription, type SystemModelSettings } from "./system-model.ts";
import { COMPLETION_RETRY, completeWithUpstreamRetry } from "./upstream-retry.ts";

/** A failed title/role call is not retried for this long, so a broken system model is not hit on every message. */
export const DESCRIBE_RETRY_MS = 10 * 60_000;

export interface SessionDescriberDeps {
	store: SessionStore;
	registry: ModelRegistry;
	systemModel?: SystemModelSettings;
	isClosing: () => boolean;
	updateSession: (id: string, patch: SessionPatch) => unknown;
}

/**
 * Background title and purpose generator using the configured system model.
 * Keeps in-flight requests deduplicated per session and applies backoff after failures.
 */
export class SessionDescriber {
	private describing = new Map<string, AbortController>();
	private failedAt = new Map<string, number>();
	private pending = new Set<Promise<void>>();
	private backfilling = false;

	constructor(private deps: SessionDescriberDeps) {}

	/**
	 * In the background, has the system model write a short title and the session's role, while the role is still
	 * empty: on the first message, and on a later one for sessions that started before a system model was set. The
	 * title is only replaced while it is still the automatic one, so a name the user gave is kept. Never fails the
	 * message: without a usable model, or when the call fails, the session keeps what it has.
	 */
	describe(id: string, first: string | undefined, latest: string, shortTitle?: string): Promise<void> | undefined {
		const target = this.deps.systemModel?.resolve();
		if (!target || this.deps.isClosing() || this.describing.has(id)) return;
		const record = this.deps.store.get(id);
		if (!record || record.purpose) return;
		if (Date.now() - (this.failedAt.get(id) ?? 0) < DESCRIBE_RETRY_MS) return;
		const firstText = first ?? this.firstUserText(id) ?? latest;
		if (!firstText.trim()) return;

		const controller = new AbortController();
		this.describing.set(id, controller);
		const job = (async () => {
			try {
				const model = this.deps.registry.models.getModel(target.provider, target.model);
				if (!model || !(await this.deps.registry.models.checkAuth(target.provider))) throw new Error("system model unavailable");
				const describeOpts = { maxTokens: DESCRIBE_MAX_TOKENS, signal: controller.signal, ...reasoningOption(target.thinkingLevel, model) };
				const describeCtx = {
					systemPrompt: DESCRIBE_SYSTEM,
					messages: [{ role: "user" as const, content: describeRequest(record.cwd, firstText, first === undefined ? latest : undefined), timestamp: Date.now() }],
				};
				const reply = await completeWithUpstreamRetry(
					(ctx) => this.deps.registry.models.completeSimple(model, ctx, describeOpts),
					describeCtx,
					COMPLETION_RETRY,
					controller.signal,
				);
				if (controller.signal.aborted) return;
				if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
				const found = parseDescription(reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
				if (!found) throw new Error("the system model gave no title");
				const now = this.deps.store.get(id);
				if (!now || now.purpose) return;
				// Only a title that is still the automatic one is replaced; one the user gave is kept.
				const automatic = now.title === "New session" || now.title === autoTitle(firstText) || now.title === shortTitle;
				const patch: SessionPatch = { purpose: found.purpose || found.title };
				if (found.title && automatic) patch.title = found.title;
				this.failedAt.delete(id);
				this.deps.updateSession(id, patch);
			} catch {
				if (!controller.signal.aborted) this.failedAt.set(id, Date.now());
			} finally {
				this.describing.delete(id);
			}
		})();
		this.pending.add(job);
		void job.finally(() => this.pending.delete(job));
		return job;
	}

	/** Gives a role to the active sessions that have talked but have none yet (after a system model is set, and at start). */
	describeAll(): void {
		if (!this.deps.systemModel?.resolve() || this.backfilling) return;
		this.backfilling = true;
		const job = (async () => {
			try {
				// One at a time: a server with many sessions must not fire them all at the model at once.
				for (const r of this.deps.store.list({ limit: 200, closed: false })) {
					if (!this.deps.systemModel?.resolve()) return;
					if (r.purpose || this.deps.store.nextSeq(r.id) === 0) continue;
					const first = this.firstUserText(r.id);
					if (first) await this.describe(r.id, first, first);
				}
			} finally {
				this.backfilling = false;
			}
		})();
		this.pending.add(job);
		void job.finally(() => this.pending.delete(job));
	}

	abort(id: string): void {
		this.describing.get(id)?.abort();
	}

	abortAll(): void {
		for (const c of this.describing.values()) c.abort();
	}

	clear(id: string): void {
		this.failedAt.delete(id);
	}

	pruneFailed(now: number): void {
		for (const [id, at] of this.failedAt) {
			if (now - at >= DESCRIBE_RETRY_MS) this.failedAt.delete(id);
		}
	}

	hasPending(): boolean {
		return this.pending.size > 0;
	}

	pendingJobs(): Promise<void>[] {
		return [...this.pending];
	}

	/** The text of the session's first user message, without the hints the server adds. */
	private firstUserText(id: string): string | null {
		const m = this.deps.store.messages(id, { limit: 50 }).find((r) => r.role === "user")?.message;
		if (!m) return null;
		const c = (m as { content?: unknown }).content;
		if (typeof c === "string") return c;
		if (!Array.isArray(c)) return null;
		const part = (c as { type: string; text?: string }[]).find((p) => p.type === "text" && p.text && !p.text.startsWith("<pipaya-"));
		return part?.text ?? null;
	}
}
