import { codenamePrefixOf } from "./member-names.ts";
import { reasoningOption, type ModelRegistry } from "./models.ts";
import type { SessionPatch, SessionRecord, SessionStore } from "./store.ts";
import {
	autoTitle,
	DESCRIBE_MAX_TOKENS,
	describeRequest,
	describeSystemPrompt,
	parseDescription,
	uniqueSessionName,
	type DescribeFields,
	type SystemModelSettings,
	type SystemModelTasks,
} from "./system-model.ts";
import { COMPLETION_RETRY, completeWithUpstreamRetry } from "./upstream-retry.ts";

/** A failed describe call is not retried for this long, so a broken system model is not hit on every message. */
export const DESCRIBE_RETRY_MS = 10 * 60_000;

export interface SessionDescriberDeps {
	store: SessionStore;
	registry: ModelRegistry;
	systemModel?: SystemModelSettings;
	takenNames?: () => Set<string>;
	isClosing: () => boolean;
	updateSession: (id: string, patch: SessionPatch) => unknown;
}

interface DoneFlags {
	sessionTitle?: boolean;
	sessionPurpose?: boolean;
	sessionName?: boolean;
}

const isAutomaticTitle = (record: SessionRecord, firstText: string, shortTitle?: string): boolean =>
	record.title === "New session" || record.title === autoTitle(firstText) || (shortTitle !== undefined && record.title === shortTitle);

/**
 * Background title, purpose, and `@name` generator using the configured system model.
 * Respects per-task toggles, keeps in-flight requests deduplicated per session, and applies backoff after failures.
 */
export class SessionDescriber {
	private describing = new Map<string, AbortController>();
	private failedAt = new Map<string, number>();
	private done = new Map<string, DoneFlags>();
	private pending = new Set<Promise<void>>();
	private backfilling = false;
	private backfillAgain = false;

	constructor(private deps: SessionDescriberDeps) {}

	private needed(record: SessionRecord, tasks: SystemModelTasks, firstText: string, allowName: boolean, shortTitle?: string, origin?: string): DescribeFields {
		const prev = this.done.get(record.id);
		return {
			title: tasks.sessionTitle && !prev?.sessionTitle && isAutomaticTitle(record, firstText, shortTitle),
			purpose: tasks.sessionPurpose && !prev?.sessionPurpose && !record.purpose,
			name: allowName && tasks.sessionName && !prev?.sessionName && !record.parentId && origin !== "peer" && codenamePrefixOf(record.name) !== null,
		};
	}

	/**
	 * In the background, asks the system model for whichever enabled fields (title, purpose, `@name`) this session still
	 * needs. User-set titles and manually renamed `@name` handles are never overwritten; `@name` generation runs only on
	 * a new top-level non-peer session's first message so existing `@A1` references stay stable. Never fails the message.
	 */
	describe(id: string, first: string | undefined, latest: string, shortTitle?: string, origin?: string, options?: { backfill?: boolean }): Promise<void> | undefined {
		const target = this.deps.systemModel?.resolve();
		const tasks = this.deps.systemModel?.get().tasks;
		if (!target || !tasks || this.deps.isClosing() || this.describing.has(id)) return;
		const record = this.deps.store.get(id);
		if (!record) return;
		if (Date.now() - (this.failedAt.get(id) ?? 0) < DESCRIBE_RETRY_MS) return;
		const firstText = first ?? this.firstUserText(id) ?? latest;
		if (!firstText.trim()) return;
		const allowName = !options?.backfill && first !== undefined;
		const want = this.needed(record, tasks, firstText, allowName, shortTitle, origin);
		if (!want.title && !want.purpose && !want.name) return;

		const initialName = record.name;
		const controller = new AbortController();
		this.describing.set(id, controller);
		const job = (async () => {
			try {
				const model = this.deps.registry.models.getModel(target.provider, target.model);
				if (!model || !(await this.deps.registry.models.checkAuth(target.provider))) throw new Error("system model unavailable");
				const describeOpts = { maxTokens: DESCRIBE_MAX_TOKENS, signal: controller.signal, ...reasoningOption(target.thinkingLevel, model) };
				const describeCtx = {
					systemPrompt: describeSystemPrompt(want),
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
				if (!found) throw new Error("the system model gave no description");

				const usable =
					(want.title && Boolean(found.title)) ||
					(want.purpose && Boolean(found.purpose || (want.title && found.title))) ||
					(want.name && Boolean(found.name));
				if (!usable) throw new Error("the system model omitted requested fields");

				if (!this.deps.systemModel?.resolve()) return;
				const now = this.deps.store.get(id);
				const liveTasks = this.deps.systemModel.get().tasks;
				if (!now) return;

				const patch: SessionPatch = {};
				const prevDone = this.done.get(id) ?? {};
				if (want.title && liveTasks.sessionTitle) {
					if (!isAutomaticTitle(now, firstText, shortTitle)) {
						prevDone.sessionTitle = true;
					} else if (found.title) {
						patch.title = found.title;
						prevDone.sessionTitle = true;
					}
				}
				if (want.purpose && liveTasks.sessionPurpose) {
					if (now.purpose) {
						prevDone.sessionPurpose = true;
					} else {
						const purpose = found.purpose || (want.title ? found.title : "");
						if (purpose) {
							patch.purpose = purpose;
							prevDone.sessionPurpose = true;
						}
					}
				}
				if (want.name && liveTasks.sessionName) {
					if (now.parentId || origin === "peer" || now.name !== initialName || codenamePrefixOf(now.name) === null) {
						prevDone.sessionName = true;
					} else if (found.name) {
						const taken = this.deps.takenNames?.() ?? this.deps.store.allNames();
						const nextName = uniqueSessionName(found.name, taken);
						if (nextName) {
							patch.name = nextName;
							prevDone.sessionName = true;
						}
					}
				}
				if (prevDone.sessionTitle || prevDone.sessionPurpose || prevDone.sessionName) this.done.set(id, prevDone);

				this.failedAt.delete(id);
				if (Object.keys(patch).length > 0) this.deps.updateSession(id, patch);
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

	/** Backfills active sessions that have talked and still need title or purpose (`@name` is only set on new sessions). */
	describeAll(): void {
		const settings = this.deps.systemModel?.get();
		if (!this.deps.systemModel?.resolve() || !settings) return;
		const { sessionTitle, sessionPurpose } = settings.tasks;
		if (!sessionTitle && !sessionPurpose) return;
		this.failedAt.clear();
		if (this.backfilling) {
			this.backfillAgain = true;
			return;
		}
		this.backfilling = true;
		const job = (async () => {
			try {
				// One at a time: a server with many sessions must not fire them all at the model at once.
				for (const r of this.deps.store.list({ limit: 200, closed: false })) {
					if (!this.deps.systemModel?.resolve()) return;
					const t = this.deps.systemModel.get().tasks;
					if (!t.sessionTitle && !t.sessionPurpose) return;
					if (this.deps.store.nextSeq(r.id) === 0) continue;
					const first = this.firstUserText(r.id);
					if (!first) continue;
					await this.describe(r.id, first, first, undefined, undefined, { backfill: true });
				}
			} finally {
				this.backfilling = false;
				if (this.backfillAgain && !this.deps.isClosing()) {
					this.backfillAgain = false;
					this.describeAll();
				} else {
					this.backfillAgain = false;
				}
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
		this.done.delete(id);
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
