import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { QuestionManager } from "./questions.ts";
import { DEFAULT_MAX_SESSIONS, type Config } from "./config.ts";
import { advertisedSkills, aggregateReadFiles, buildSystemPrompt, previewContext, type ContextSnapshot, type SessionContext } from "./context.ts";
import { mentionedSkills, readSkillText, skillCallHint, skillsPrompt, type SkillRef, type SkillService } from "./skills.ts";
import { badRequest, conflict, HttpError, notFound } from "./errors.ts";
import { filesNote, saveUploads } from "./file-routes.ts";
import type { EventBus } from "./events.ts";
import type { ModelRegistry } from "./models.ts";
import { estimateTokens, pickCut, SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, summaryMessage, summaryRequest, thresholdFor, type CompactionSettings } from "./compaction.ts";
import { type SessionPatch, type SessionRecord, type SessionStore, } from "./store.ts";
import { buildTools, DEFAULT_TOOLS, isInside, TOOL_DEFS, type ToolContext, type ToolDef } from "./tools.ts";
import { groupHandle, nameInLang, nextMemberName, MEMBER_NAMES_EN, poolForLang, poolOfName } from "./member-names.ts";
import type { ExtensionHost } from "./extensions/host.ts";
import type { MessageNote } from "./extensions/types.ts";
import { autoTitle, DESCRIBE_MAX_TOKENS, DESCRIBE_SYSTEM, describeRequest, parseDescription, type SystemModelSettings } from "./system-model.ts";

import { DEFAULT_SYSTEM_PROMPT, FORCE_STOP_MS, IDLE_EVICT_MS, MAX_REPEATED_CALLS, MAX_RUN_TURNS, skillsKey, type CompactionOutcome, type CreateSessionInput, type Live, type PromptMode, type SessionStatus } from "./session-types.ts";
export { DEFAULT_SYSTEM_PROMPT } from "./session-types.ts";
export type { CompactionOutcome, CreateSessionInput, PromptMode, SessionStatus } from "./session-types.ts";

export const NOTE_OPEN = "<pipaya-note>";
const NOTE_CLOSE = "</pipaya-note>";

/** A note for the client, stored with the user message: `{ text, collapse?, data?, call }` (`call` = what the user typed). */
export function noteBlock(note: MessageNote, call: string): string {
	const body = { text: String(note.text).slice(0, 200), ...(note.collapse ? { collapse: true } : {}), ...(note.data !== undefined ? { data: note.data } : {}), call: call.slice(0, 2000) };
	return `${NOTE_OPEN}${JSON.stringify(body).slice(0, 16_000)}${NOTE_CLOSE}`;
}

/** The model never sees notes: they are for the people reading the transcript. */
function withoutNotes(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((m) => {
		if (m.role !== "user" || !Array.isArray(m.content)) return m;
		const kept = m.content.filter((c) => !(c.type === "text" && c.text.startsWith(NOTE_OPEN)));
		return kept.length === m.content.length ? m : { ...m, content: kept };
	});
}

/** Strip the heavy `partial` snapshot from stream deltas; clients rebuild from deltas. */
function slimAssistantEvent(e: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"]): unknown {
	const { partial: _partial, ...rest } = e as typeof e & { partial?: unknown };
	return rest;
}

/** How many messages one run may send to group members. */
/** A failed title/role call is not retried for this long, so a broken system model is not hit on every message. */
const DESCRIBE_RETRY_MS = 10 * 60_000;

export class SessionManager {
	private live = new Map<string, Live>();
	/** Runs that have not yet published run_finished. Tracked apart from `live`, which shutdown and delete empty first. */
	private pendingRuns = new Set<Promise<void>>();
	/** Title/role calls in flight (one per session), and when one last failed. */
	private describing = new Map<string, AbortController>();
	private describeFailedAt = new Map<string, number>();
	private pendingDescribes = new Set<Promise<void>>();
	private backfilling = false;
	private closing = false;
	private sweeper: ReturnType<typeof setInterval>;
	/** Session ids of every group, wired by the app once the group manager exists; `@group` mentions read it. */
	private groupSource: () => { name: string; sessionIds: string[] }[] = () => [];

	setGroupSource(fn: () => { name: string; sessionIds: string[] }[]): void {
		this.groupSource = fn;
	}

	constructor(
		private cfg: Config,
		private store: SessionStore,
		private bus: EventBus,
		private registry: ModelRegistry,
		/** Where sessions start, and what relative cwd values resolve against. */
		private defaultWorkdir: () => string = () => cfg.workspaceRoot,
		private skills?: SkillService,
		private questions?: QuestionManager,
		private compaction?: CompactionSettings,
		private ext?: ExtensionHost,
		/** Switchable tools the user turned off in the settings; withheld from every session. */
		private disabledTools: () => string[] = () => [],
		/** The light model that writes session titles and roles; none = titles stay the first message cut short. */
		private systemModel?: SystemModelSettings,
	) {
		this.sweeper = setInterval(() => this.evictIdle(), 5 * 60_000);
		this.sweeper.unref?.();
	}

	// ── CRUD ────────────────────────────────────────────────────────────────

	/** Throws when one more active session would pass the server limit (PIPAYA_MAX_SESSIONS). */
	private assertRoom(): void {
		const max = this.cfg.maxActiveSessions ?? DEFAULT_MAX_SESSIONS;
		if (max > 0 && this.store.activeCount() >= max) throw conflict(`session limit reached (${max} active sessions); close or delete one first`);
	}

	async create(input: CreateSessionInput, parentId: string | null = null): Promise<SessionRecord> {
		this.assertRoom();
		const { provider, model } = await this.resolveModel(input.provider, input.model);
		const tools = this.validateTools(input.tools ?? this.ext?.defaultTools() ?? DEFAULT_TOOLS);
		const id = randomUUID();
		const cwd = this.resolveCwd(input.cwd);
		const now = Date.now();
		const record: SessionRecord = {
			id,
			title: input.title?.trim() || "New session",
			name: nextMemberName(this.takenNames(), poolForLang(input.lang)),
			purpose: "",
			cwd,
			provider,
			model,
			thinkingLevel: input.thinkingLevel ?? this.registry.defaultSelection?.()?.thinkingLevel ?? "medium",
			systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			tools,
			parentId,
			closed: false,
			createdAt: now,
			updatedAt: now,
		};
		this.store.create(record);
		this.bus.publish(id, "session_created", record);
		this.ext?.notify("session_start", { sessionId: id }, id);
		return record;
	}

	get(id: string): SessionRecord {
		const s = this.store.get(id);
		if (!s) throw notFound("session");
		return s;
	}

	/** AGENTS.md is frozen at the first run; skills always follow the current on/off settings. */
	private currentSkills(id: string, snapshot: Pick<ContextSnapshot, "cwd" | "tools">): SkillRef[] {
		return advertisedSkills(snapshot.tools, this.skills?.active(snapshot.cwd, id) ?? []);
	}

	context(id: string): SessionContext {
		const record = this.get(id);
		const snapshot = this.store.context(id);
		const base = snapshot ?? previewContext(record, this.skills?.active(record.cwd, id), undefined);
		const skills = snapshot ? this.currentSkills(id, snapshot) : (base.skills ?? []);
		return {
			...base,
			skillsPrompt: skills.length ? skillsPrompt(skills) : "",
			effectiveSystemPrompt: snapshot ? buildSystemPrompt(snapshot.systemPrompt, snapshot.instructions, skills) : base.effectiveSystemPrompt,
			// baseDir is an internal read allow-list entry, not part of the API.
			skills: skills.map(({ name, description, path, scope }) => ({ name, description, path, scope })),
			state: snapshot ? "applied" : "preview",
			capturedAt: snapshot?.capturedAt ?? null,
			readFiles: aggregateReadFiles(record.cwd, this.store.toolResults(id, "read")),
		};
	}

	status(id: string): SessionStatus {
		this.get(id);
		const live = this.live.get(id);
		return {
			running: live?.running ?? false,
			pendingToolCalls: live ? [...live.agent.state.pendingToolCalls] : [],
			pendingQuestions: this.questions?.list(id).length ?? 0,
			streamingMessage: (live?.running && live.agent.state.streamingMessage) || null,
			queued: live?.agent.hasQueuedMessages() ?? false,
			lastError: live?.agent.state.errorMessage ?? null,
			compacting: !!live?.compacting,
		};
	}

	/** Tokens the next model request will carry (estimated) against the current model's window. */
	contextUsage(id: string): { tokens: number | null; contextWindow: number } | null {
		const record = this.get(id);
		const model = this.registry.models.getModel(record.provider, record.model);
		if (!model) return null;
		const live = this.live.get(id);
		const messages = live ? live.agent.state.messages : this.projectedMessages(id);
		const system = live ? live.agent.state.systemPrompt.length / 4 : 0;
		return { tokens: Math.ceil(system + messages.reduce((n, m) => n + estimateTokens(m), 0)), contextWindow: model.contextWindow };
	}

	/** What the model sees for a session: the latest summary, then everything after it. */
	private projectedMessages(id: string): AgentMessage[] {
		const { summary, messages } = this.store.projection(id);
		const rest = messages.map((m) => m.message);
		return summary ? [summaryMessage(summary), ...rest] : rest;
	}

	/**
	 * Summarizes everything before the most recent exchanges and makes the model see the summary instead. The
	 * stored transcript is never changed. The summary is written by the configured compaction model, or by the
	 * session's own model when none is configured.
	 */
	async compact(id: string, instructions?: string, reason: "manual" | "threshold" = "manual"): Promise<CompactionOutcome> {
		const record = this.get(id);
		if (record.closed) throw conflict("session is closed; resume it first (PATCH closed=false)");
		const live = this.ensureLive(record);
		if (live.compacting) throw conflict("this session is already being compacted");
		if (live.running && reason === "manual") throw conflict("the session is working; compact after it finishes");
		if (this.questions?.list(id).length) throw conflict("the session is waiting for an answer; respond first");
		if (!this.compaction) throw new HttpError(501, "compaction_not_supported", "compaction is not available on this server");

		const stored = this.store.projection(id);
		const cutAt = pickCut(stored.messages.map((m) => m.message));
		if (cutAt === null) throw conflict("not enough history to compact yet");
		const toSummarize = stored.messages.slice(0, cutAt).map((m) => ({ ...m, message: withoutNotes([m.message])[0]! }));
		const uptoSeq = toSummarize[toSummarize.length - 1]!.seq;

		const target = this.compaction.resolveModel(record);
		const model = this.registry.models.getModel(target.provider, target.model);
		if (!model) throw badRequest(`model ${target.provider}/${target.model} is not available`);
		if (!(await this.registry.models.checkAuth(target.provider))) throw badRequest(`provider ${target.provider} is not configured; set its API key first`);

		const before = this.contextUsage(id)?.tokens ?? 0;
		let custom: string | undefined;
		if (this.ext?.has("session_before_compact")) {
			let cancelled = false;
			await this.ext.emit("session_before_compact", {
				sessionId: id, reason, messages: toSummarize.map((m) => m.message), previousSummary: stored.summary, instructions,
			}, id, (r) => {
				if (r.cancel) { cancelled = true; return true; }
				if (typeof r.summary === "string" && r.summary.trim()) { custom = r.summary.trim(); return true; }
			});
			if (cancelled) throw conflict("compaction was cancelled by an extension");
		}
		const controller = new AbortController();
		live.compacting = controller;
		let settle!: () => void;
		live.compactSettled = new Promise<void>((r) => { settle = r; });
		this.bus.publish(id, "compaction_started", { reason });
		try {
			const reply = custom !== undefined ? ({ stopReason: "stop", content: [{ type: "text", text: custom }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } as unknown as Awaited<ReturnType<typeof this.registry.models.completeSimple>>) : await this.registry.models.completeSimple(
				model,
				{ systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: summaryRequest(stored.summary, toSummarize.map((m) => m.message), instructions), timestamp: Date.now() }] },
				{ maxTokens: SUMMARY_MAX_TOKENS, signal: controller.signal, ...(target.thinkingLevel && model.reasoning ? { reasoning: target.thinkingLevel } : {}) },
			);
			if (reply.stopReason === "aborted") throw Object.assign(new Error("compaction cancelled"), { aborted: true });
			if (reply.stopReason === "error") throw new Error(reply.errorMessage || "the summary model failed");
			const summary = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
			if (!summary) throw new Error("the summary model returned nothing");
			// The transcript may have grown while the summary was written; only what was summarized is replaced.
			const u = reply.usage;
			this.store.addCompaction(id, {
				uptoSeq, summary, tokensBefore: before,
				usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: u.cost.total },
			});
			live.agent.state.messages = this.projectedMessages(id);
			live.lastActive = Date.now();
			const context = this.contextUsage(id) ?? { tokens: null, contextWindow: model.contextWindow };
			const outcome: CompactionOutcome = { tokensBefore: before, context, model: target };
			this.bus.publish(id, "compaction_finished", { tokensBefore: before, context, usage: this.store.usage(id) });
			this.ext?.notify("session_compact", { sessionId: id, summary, tokensBefore: before }, id);
			this.bus.publish(id, "context_updated", { context });
			return outcome;
		} catch (e) {
			const aborted = controller.signal.aborted || (e as { aborted?: boolean }).aborted === true;
			const errorMessage = e instanceof Error ? e.message : String(e);
			this.bus.publish(id, "compaction_failed", { aborted, ...(aborted ? {} : { errorMessage }) });
			if (aborted) throw conflict("compaction cancelled");
			throw e instanceof HttpError ? e : new HttpError(502, "upstream_error", errorMessage);
		} finally {
			live.compacting = undefined;
			live.compactSettled = undefined;
			settle();
		}
	}

	/** Before a prompt: compact first when automatic compaction is on and the context is nearly full. */
	private async autoCompact(id: string): Promise<void> {
		const settings = this.compaction?.get();
		if (!settings?.auto) return;
		const usage = this.contextUsage(id);
		if (!usage?.tokens || usage.tokens < thresholdFor(usage.contextWindow, settings.thresholdPercent)) return;
		try {
			await this.compact(id, undefined, "threshold");
		} catch { /* the prompt still goes out; compact() already published why it did not happen */ }
	}

	/** Lower-cased names a new session must not take: the active sessions' and the tags of the groups. */
	private takenNames(): Set<string> {
		const taken = new Set(this.store.activeNames());
		for (const g of this.groupSource()) taken.add(groupHandle(g.name).toLowerCase());
		return taken;
	}

	/** The UI language changed: give every session the twin of its name in that language (민수 <-> Minsu). Returns how many were renamed. */
	localizeNames(lang: string): number {
		const pool = poolForLang(lang);
		let renamed = 0;
		for (const r of this.store.list({ limit: 1000 })) {
			let name = nameInLang(r.name, lang);
			if (name === r.name) continue;
			if (!r.closed && this.takenNames().has(name.toLowerCase())) name = nextMemberName(this.takenNames(), pool);
			this.update(r.id, { name });
			renamed++;
		}
		return renamed;
	}

	update(id: string, patch: SessionPatch): SessionRecord {
		const current = this.get(id);
		const clean: SessionPatch = { ...patch };

		if (patch.provider !== undefined || patch.model !== undefined) {
			const provider = patch.provider ?? current.provider;
			const model = patch.model ?? current.model;
			if (!this.registry.models.getModel(provider, model)) throw badRequest(`unknown model ${provider}/${model}`);
		}
		if (patch.tools !== undefined || patch.systemPrompt !== undefined) {
			// The prompt and tool declarations are baked into the transcript head; changing them
			// after the first message would desynchronise a reloaded session from its history.
			if (this.store.nextSeq(id) > 0 || this.store.context(id)) {
				throw conflict("systemPrompt and tools can only change before the first message; fork the session instead");
			}
			if (patch.tools) clean.tools = this.validateTools(patch.tools);
		}

		if (patch.closed === false && current.closed) this.assertRoom();
		// A closed session gives its name up; on resume it takes it back unless another session has it by now (or it never had one).
		if (patch.closed === false && current.closed && (!current.name || this.takenNames().has(current.name.toLowerCase()))) clean.name = nextMemberName(this.takenNames(), poolOfName(current.name));
		const updated = this.store.update(id, clean);
		if (!updated) throw notFound("session");

		const live = this.live.get(id);
		if (patch.closed && live?.running) live.agent.abort(); // closing stops the work
		if (live) {
			if (clean.provider || clean.model) {
				const m = this.registry.models.getModel(updated.provider, updated.model);
				if (m) live.agent.state.model = m;
			}
			if (clean.thinkingLevel) live.agent.state.thinkingLevel = clean.thinkingLevel;
			if (clean.systemPrompt !== undefined || clean.tools) this.dispose(id);
		}
		this.bus.publish(id, "session_updated", updated);
		return updated;
	}

	isRunning(id: string): boolean {
		return this.live.get(id)?.running ?? false;
	}

	delete(id: string): void {
		this.get(id);
		const live = this.live.get(id);
		if (live?.running) live.agent.abort();
		this.describing.get(id)?.abort();
		this.dispose(id);
		this.store.delete(id);
		this.bus.publish(null, "session_deleted", { id });
	}

	async fork(id: string, atSeq?: number, title?: string): Promise<SessionRecord> {
		const src = this.get(id);
		const copy = await this.create(
			{
				title: title ?? `${src.title} (fork)`,
				cwd: src.cwd,
				provider: src.provider,
				model: src.model,
				thinkingLevel: src.thinkingLevel,
				systemPrompt: src.systemPrompt,
				tools: src.tools,
				lang: poolOfName(src.name) === MEMBER_NAMES_EN ? "en" : "ko",
			},
			src.id,
		);
		const copied = this.store.copyMessages(id, copy.id, atSeq);
		this.bus.publish(copy.id, "session_forked", { from: id, atSeq: atSeq ?? null, messages: copied });
		this.ext?.notify("session_fork", { sessionId: copy.id, from: id }, copy.id);
		return this.get(copy.id);
	}

	// ── Running ─────────────────────────────────────────────────────────────

	async send(
		id: string,
		input: { text: string; images?: ImageContent[]; files?: { name: string; data: string }[]; mode?: PromptMode },
	): Promise<{ accepted: "prompt" | "steer" | "follow_up" }> {
		const record = this.get(id);
		if (record.closed) throw conflict("session is closed; resume it first (PATCH closed=false)");
		const mode = input.mode ?? "prompt";
		let extraParts: { type: "text"; text: string }[] = [];
		let inputTitle: string | undefined;
		if (this.ext) {
			const pre = await this.preprocess(id, input.text, mode);
			if (pre.handled) return { accepted: mode };
			input = { ...input, text: pre.text };
			extraParts = pre.parts;
			inputTitle = pre.title;
		}
		// A prompt sent during a manual compaction waits for it to finish instead of being rejected.
		const compacting = this.live.get(id);
		if (mode === "prompt" && compacting?.compacting && !compacting.running) await compacting.compactSettled;
		const active = this.live.get(id)?.running ?? false;
		if (mode !== "prompt" && !active) throw conflict(`session is idle; use mode "prompt" (mode "${mode}" needs an active run)`);
		if (mode === "prompt" && active) throw conflict('session is busy; send with mode "steer" or "follow_up"');
		const live = this.ensureLive(record);

		const content: ({ type: "text"; text: string } | ImageContent)[] = [{ type: "text", text: input.text }, ...extraParts];
		if (this.skills) {
			const callable = this.skills.callable(record.cwd, id);
			for (const name of mentionedSkills(input.text, callable.map((s) => s.name))) {
				const skill = callable.find((s) => s.name === name)!;
				const body = readSkillText(skill.path);
				if (body !== null) content.push({ type: "text", text: skillCallHint(skill, body, "<pipaya-hint>") });
			}
		}
		if (input.images?.length) content.push(...input.images);
		if (input.files?.length) {
			const saved = await saveUploads(record.cwd, input.files);
			content.push({ type: "text", text: filesNote(saved) });
		}
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };

		if (mode === "steer" || mode === "follow_up") {
			if (!live.running) throw conflict(`session is idle; use mode "prompt" (mode "${mode}" needs an active run)`);
			if (mode === "steer") live.agent.steer(message);
			else live.agent.followUp(message);
			this.bus.publish(id, "message_queued", { mode, text: input.text });
			return { accepted: mode };
		}

		if (live.running) throw conflict('session is busy; send with mode "steer" or "follow_up"');
		const first = this.store.nextSeq(id) === 0;
		const shortTitle = autoTitle(inputTitle ?? input.text);
		if (record.title === "New session" && first) this.update(id, { title: shortTitle });
		this.describe(id, first ? input.text : undefined, input.text, shortTitle);
		this.run(id, live, "prompt", async () => {
			await this.autoCompact(id);
			live.runSystem = undefined;
			if (this.ext?.has("before_agent_start")) {
				await this.ext.emit("before_agent_start", { sessionId: id, text: input.text }, id, (r) => {
					if (r.systemPrompt !== undefined) live.runSystem = { ...live.runSystem, replace: r.systemPrompt };
					if (r.appendSystemPrompt) live.runSystem = { ...live.runSystem, append: `${live.runSystem?.append ?? ""}\n\n${r.appendSystemPrompt}` };
					if (r.message) (message.content as { type: string; text?: string }[]).push({ type: "text", text: r.message });
				});
			}
			await live.agent.prompt(message);
		});
		return { accepted: "prompt" };
	}

	/**
	 * In the background, has the system model write a short title and the session's role, while the role is still
	 * empty: on the first message, and on a later one for sessions that started before a system model was set. The
	 * title is only replaced while it is still the automatic one, so a name the user gave is kept. Never fails the
	 * message: without a usable model, or when the call fails, the session keeps what it has.
	 */
	private describe(id: string, first: string | undefined, latest: string, shortTitle?: string): Promise<void> | undefined {
		const target = this.systemModel?.resolve();
		if (!target || this.closing || this.describing.has(id)) return;
		const record = this.store.get(id);
		if (!record || record.purpose) return;
		if (Date.now() - (this.describeFailedAt.get(id) ?? 0) < DESCRIBE_RETRY_MS) return;
		const firstText = first ?? this.firstUserText(id) ?? latest;
		if (!firstText.trim()) return;
		const controller = new AbortController();
		this.describing.set(id, controller);
		const job = (async () => {
			try {
				const model = this.registry.models.getModel(target.provider, target.model);
				if (!model || !(await this.registry.models.checkAuth(target.provider))) throw new Error("system model unavailable");
				const reply = await this.registry.models.completeSimple(
					model,
					{ systemPrompt: DESCRIBE_SYSTEM, messages: [{ role: "user", content: describeRequest(record.cwd, firstText, first === undefined ? latest : undefined), timestamp: Date.now() }] },
					{ maxTokens: DESCRIBE_MAX_TOKENS, signal: controller.signal, ...(target.thinkingLevel && model.reasoning ? { reasoning: target.thinkingLevel } : {}) },
				);
				if (controller.signal.aborted) return;
				if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || reply.stopReason);
				const found = parseDescription(reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
				if (!found) throw new Error("the system model gave no title");
				const now = this.store.get(id);
				if (!now || now.purpose) return;
				// Only a title that is still the automatic one is replaced; one the user gave is kept.
				const automatic = now.title === "New session" || now.title === autoTitle(firstText) || now.title === shortTitle;
				const patch: SessionPatch = { purpose: found.purpose || found.title };
				if (found.title && automatic) patch.title = found.title;
				this.describeFailedAt.delete(id);
				this.update(id, patch);
			} catch {
				if (!controller.signal.aborted) this.describeFailedAt.set(id, Date.now());
			} finally {
				this.describing.delete(id);
			}
		})();
		this.pendingDescribes.add(job);
		void job.finally(() => this.pendingDescribes.delete(job));
		return job;
	}

	/** Gives a role to the active sessions that have talked but have none yet (after a system model is set, and at start). */
	describeAll(): void {
		if (!this.systemModel?.resolve() || this.backfilling) return;
		this.backfilling = true;
		const job = (async () => {
			try {
				// One at a time: a server with many sessions must not fire them all at the model at once.
				for (const r of this.store.list({ limit: 200, closed: false })) {
					if (!this.systemModel?.resolve()) return;
					if (r.purpose || this.store.nextSeq(r.id) === 0) continue;
					const first = this.firstUserText(r.id);
					if (first) await this.describe(r.id, first, first);
				}
			} finally {
				this.backfilling = false;
			}
		})();
		this.pendingDescribes.add(job);
		void job.finally(() => this.pendingDescribes.delete(job));
	}

	/** The text of the session's first user message, without the hints the server adds. */
	private firstUserText(id: string): string | null {
		const m = this.store.messages(id, { limit: 50 }).find((r) => r.role === "user")?.message;
		if (!m) return null;
		const c = (m as { content?: unknown }).content;
		if (typeof c === "string") return c;
		if (!Array.isArray(c)) return null;
		const part = (c as { type: string; text?: string }[]).find((p) => p.type === "text" && p.text && !p.text.startsWith("<pipaya-"));
		return part?.text ?? null;
	}

	/** `input` hooks and `/command` handling. A swallowed message is never sent to the model. */
	private async preprocess(id: string, text: string, mode: PromptMode): Promise<{ handled: boolean; text: string; parts: { type: "text"; text: string }[]; title?: string }> {
		let current = text;
		let handled = false;
		const parts: { type: "text"; text: string }[] = [];
		let title: string | undefined;
		let note: MessageNote | undefined;
		const typed = text.trim();
		await this.ext!.emit("input", { sessionId: id, text: current, mode }, id, (r) => {
			if (typeof r.text === "string") current = r.text;
			if (Array.isArray(r.parts)) for (const p of r.parts) if (p?.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
			if (typeof r.title === "string" && r.title.trim()) title = r.title;
			if (r.note && typeof r.note.text === "string") note = r.note;
			if (r.handled) { handled = true; return true; }
		});
		const withNote = () => (note ? [...parts, { type: "text" as const, text: noteBlock(note, typed) }] : parts);
		if (handled) return { handled, text: current, parts, title };
		const cmd = await this.ext!.runCommand(id, current);
		if (cmd?.note) note = cmd.note;
		if (cmd?.title) title = cmd.title;
		if (cmd) return cmd.prompt ? { handled: false, text: cmd.prompt, parts: withNote(), title } : { handled: true, text: current, parts, title };
		return { handled: false, text: current, parts: withNote(), title };
	}

	/** Removes one not-yet-delivered steer/follow_up message (the first one in that queue with this text). */
	cancelQueued(id: string, mode: "steer" | "follow_up", text: string): boolean {
		this.get(id);
		const live = this.live.get(id);
		if (!live) return false;
		// pi-agent-core has no per-item removal API; its queues are plain arrays.
		const queue = (live.agent as unknown as Record<string, { messages?: AgentMessage[] } | undefined>)[mode === "steer" ? "steeringQueue" : "followUpQueue"];
		const items = queue?.messages;
		if (!Array.isArray(items)) return false;
		const textOf = (m: AgentMessage) => {
			const c = (m as { content?: unknown }).content;
			if (typeof c === "string") return c;
			return Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : "")).join("") : "";
		};
		const i = items.findIndex((m) => textOf(m) === text);
		if (i < 0) return false;
		items.splice(i, 1);
		this.bus.publish(id, "message_dequeued", { mode, text });
		return true;
	}

	/** Retry after an error/abort: drops the failed assistant message and re-requests. */
	retry(id: string): void {
		const record = this.get(id);
		if (record.closed) throw conflict("session is closed; resume it first (PATCH closed=false)");
		if (this.live.get(id)?.running) throw conflict("session is busy");
		const history = this.store.lastMessages(id, 2).map((m) => m.message);
		const lastStored = history.at(-1);
		const retryTail = lastStored?.role === "assistant" && (lastStored.stopReason === "error" || lastStored.stopReason === "aborted")
			? history.at(-2) : lastStored;
		if (!retryTail || retryTail.role === "assistant" || retryTail.role === "system") throw conflict("nothing to retry");
		const live = this.ensureLive(record);

		const messages = live.agent.state.messages;
		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
			this.store.deleteLastMessage(id);
			live.nextSeq--;
			live.agent.state.messages = messages.slice(0, -1);
		}
		const tail = live.agent.state.messages[live.agent.state.messages.length - 1];
		if (!tail || tail.role === "assistant" || tail.role === "system") throw conflict("nothing to retry");
		this.run(id, live, "retry", () => live.agent.continue());
	}

	abort(id: string): boolean {
		this.get(id);
		const live = this.live.get(id);
		if (!live) return false;
		let did = false;
		if (live.compacting) { live.compacting.abort(); did = true; }
		if (live.running) { this.abortRun(id, live); did = true; }
		return did;
	}

	/**
	 * Cooperative abort, then a hard stop: if the run is still going after FORCE_STOP_MS (a provider stream or tool that
	 * ignores the signal), drop the stuck agent, publish run_finished ourselves and let the next message start fresh
	 * from the stored transcript. Without this, Esc could leave a session "running" forever.
	 */
	private abortRun(id: string, live: Live): void {
		const settled = live.settled;
		live.agent.abort();
		const timer = setTimeout(() => {
			if (!live.running || live.settled !== settled || this.live.get(id) !== live) return;
			live.forceStopped = true;
			live.running = false;
			live.lastActive = Date.now();
			this.dispose(id);
			this.bus.publish(id, "run_finished", {
				status: "aborted",
				error: "The run did not stop in time and was forced to stop.",
				durationMs: Date.now() - live.runStartedAt,
				usage: this.store.usage(id),
			});
		}, FORCE_STOP_MS);
		timer.unref?.();
		void settled?.finally(() => clearTimeout(timer));
	}

	shutdown(): void {
		clearInterval(this.sweeper);
		this.closing = true;
		for (const c of this.describing.values()) c.abort();
		for (const id of this.live.keys()) this.ext?.notify("session_shutdown", { sessionId: id }, id);
		for (const [id, live] of this.live) {
			if (live.running) live.agent.abort();
			this.dispose(id);
		}
	}

	/** Live state of every session that is running or waiting on the user (idle sessions are omitted). */
	activity(): { sessionId: string; running: boolean; pendingQuestions: number }[] {
		type Row = { sessionId: string; running: boolean; pendingQuestions: number };
		const out = new Map<string, Row>();
		const row = (sessionId: string): Row => {
			let e = out.get(sessionId);
			if (!e) out.set(sessionId, (e = { sessionId, running: false, pendingQuestions: 0 }));
			return e;
		};
		for (const [sessionId, l] of this.live) if (l.running) row(sessionId).running = true;
		for (const r of this.questions?.list() ?? []) row(r.sessionId).pendingQuestions++;
		return [...out.values()];
	}

	get runningCount(): number {
		return [...this.live.values()].filter((l) => l.running).length;
	}

	/** Wait until every active run has settled (used on shutdown and in tests). */
	async idle(): Promise<void> {
		await Promise.all([...this.live.values()].map((l) => l.agent.waitForIdle()));
		await Promise.all([...this.pendingRuns]);
		await Promise.all([...this.pendingDescribes]);
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private run(id: string, live: Live, mode: string, start: () => Promise<void>): void {
		live.running = true;
		live.runStartedAt = Date.now();
		live.turns = 0;
		live.recentCalls = [];
		this.bus.publish(id, "run_started", { mode });

		const settled = (async () => {
			let error: string | null = null;
			try {
				await start();
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			if (live.forceStopped) return; // run_finished was already published when it was cut loose
			live.running = false;
			live.lastActive = Date.now();
			const last = live.agent.state.messages[live.agent.state.messages.length - 1];
			const failed = last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
			error ??= failed ? (last.errorMessage ?? null) : null;
			const status = !failed && !error ? "ok" : last?.role === "assistant" && last.stopReason === "aborted" ? "aborted" : "error";
			this.bus.publish(id, "run_finished", {
				status,
				error,
				durationMs: Date.now() - live.runStartedAt,
				usage: this.store.usage(id),
			});
		})();
		live.settled = settled;
		this.pendingRuns.add(settled);
		void settled.finally(() => this.pendingRuns.delete(settled));
	}

	private ensureLive(record: SessionRecord): Live {
		const existing = this.live.get(record.id);
		if (existing) {
			// Refresh idle sessions after provider endpoint/model configuration changes.
			if (!existing.running) {
				const model = this.registry.models.getModel(record.provider, record.model);
				if (!model) throw badRequest(`unknown model ${record.provider}/${record.model}`);
				existing.agent.state.model = model;
				this.syncSkills(record.id, existing);
				const snap = this.store.context(record.id);
				if (snap) existing.agent.state.tools = this.sessionTools(record.id, snap.tools, snap.cwd, existing.readRoots);
			}
			return existing;
		}

		const model = this.registry.models.getModel(record.provider, record.model);
		if (!model) throw badRequest(`model ${record.provider}/${record.model} is not available`);

		const history = this.projectedMessages(record.id);
		const snapshot = this.store.context(record.id) ?? this.store.captureContext(record.id, {
			...previewContext(record, this.skills?.active(record.cwd, record.id), undefined), capturedAt: Date.now(),
		});
		const skills = this.currentSkills(record.id, snapshot);
		const readRoots = skills.map((k) => k.baseDir);
		const agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(snapshot.systemPrompt, snapshot.instructions, skills),
				model,
				thinkingLevel: record.thinkingLevel,
				tools: this.sessionTools(record.id, snapshot.tools, snapshot.cwd, readRoots),
				messages: history,
			},
			streamFn: this.registry.models.streamSimple.bind(this.registry.models),
			sessionId: record.id,
			transformContext: async (messages) => this.transformContext(record.id, messages),
			beforeToolCall: async (c) => this.extensionToolCall(record.id, c),
			afterToolCall: async (c) => this.extensionToolResult(record.id, c),
		});

		const live: Live = {
			agent,
			nextSeq: this.store.nextSeq(record.id),
			running: false,
			runStartedAt: 0,
			lastActive: Date.now(),
			unsubscribe: () => {},
			skillsKey: skillsKey(skills),
			readRoots,
			turns: 0,
			recentCalls: [],
		};
		live.unsubscribe = agent.subscribe((event) => this.onAgentEvent(record.id, live, event));
		this.live.set(record.id, live);
		return live;
	}

	/**
	 * Applies skill on/off changes to an idle session before its next run: rewrites the leading system
	 * message and the read allow-list. Nothing happens (and the provider's prompt cache is untouched)
	 * unless the enabled set actually changed.
	 */
	private syncSkills(id: string, live: Live): void {
		const snapshot = this.store.context(id);
		if (!snapshot) return;
		const skills = this.currentSkills(id, snapshot);
		const key = skillsKey(skills);
		if (key === live.skillsKey) return;
		const [head, ...rest] = live.agent.state.messages;
		if (head?.role === "system") {
			live.agent.state.messages = [{ ...head, content: buildSystemPrompt(snapshot.systemPrompt, snapshot.instructions, skills) } as AgentMessage, ...rest];
		}
		live.readRoots.splice(0, live.readRoots.length, ...skills.map((k) => k.baseDir));
		live.skillsKey = key;
	}

	/** The tools a session's agent gets; tools the user switched off in the settings are left out. */
	private sessionTools(id: string, names: string[], cwd: string, readRoots: string[]) {
		const off = this.disabledTools();
		const all = [...new Set([...names, ...(this.ext?.alwaysTools() ?? [])])].filter((n) => !off.includes(n));
		return buildTools(all, cwd, readRoots, this.toolContext(id), this.toolDefs());
	}

	/** What tools may ask of the running session. */
	private toolContext(sessionId: string): ToolContext {
		const ctx: ToolContext = { sessionId };
		ctx.canSeeImages = () => {
			const rec = this.store.get(sessionId);
			const model = rec && this.registry.models.getModel(rec.provider, rec.model);
			return model ? model.input.includes("image") : true;
		};
		ctx.imageLimits = () => {
			const rec = this.store.get(sessionId);
			return rec ? this.registry.models.getModel(rec.provider, rec.model)?.inputLimits?.images?.resize : undefined;
		};
		return ctx;
	}


	/** Stops a run that has gone past the turn budget or keeps issuing the identical tool call. */
	private guardRunaway(sessionId: string, live: Live, event: Extract<AgentEvent, { type: "turn_end" }>): void {
		live.turns++;
		const content = (event.message as { content?: unknown }).content;
		const calls = Array.isArray(content)
			? content.filter((b) => b?.type === "toolCall").map((b) => `${b.name}:${JSON.stringify(b.arguments)}`).sort().join("|")
			: "";
		// Only turns that ended in tool calls can be a loop; a plain answer ends the run on its own.
		live.recentCalls = calls ? [...live.recentCalls, calls].slice(-MAX_REPEATED_CALLS) : [];
		let reason: string | null = null;
		if (live.turns >= MAX_RUN_TURNS) {
			reason = `Stopped after ${MAX_RUN_TURNS} model calls in one run. Send a message to continue.`;
		} else if (live.recentCalls.length === MAX_REPEATED_CALLS && live.recentCalls.every((c) => c === live.recentCalls[0])) {
			reason = `Stopped: the same tool call was repeated ${MAX_REPEATED_CALLS} times in a row.`;
		}
		if (!reason || !live.running) return;
		this.bus.publish(sessionId, "run_limit", { reason, turns: live.turns });
		this.abortRun(sessionId, live);
	}

	/** `tool_call` hooks. Shared by the session agent and its helpers so a policy extension cannot be sidestepped. */
	private async extensionToolCall(sessionId: string, { toolCall, args }: { toolCall: { id: string; name: string }; args: unknown }): Promise<{ block: true; reason: string } | undefined> {
		if (!this.ext?.has("tool_call")) return undefined;
		let blocked: { block: true; reason: string } | undefined;
		await this.ext.emit("tool_call", { sessionId, toolCallId: toolCall.id, toolName: toolCall.name, args }, sessionId, (r) => {
			if (r.block) { blocked = { block: true, reason: r.reason ?? `"${toolCall.name}" was blocked by an extension` }; return true; }
		});
		return blocked;
	}

	/** `tool_result` hooks: each extension sees what the previous one returned. */
	private async extensionToolResult(sessionId: string, { toolCall, args, result, isError }: { toolCall: { id: string; name: string }; args: unknown; result: { content: unknown; details?: unknown }; isError: boolean }) {
		if (!this.ext?.has("tool_result")) return undefined;
		let out: { content?: any[]; details?: unknown; isError?: boolean } | undefined;
		let content = result.content as any[];
		let details = result.details as unknown;
		let err = isError;
		await this.ext.emit("tool_result", { sessionId, toolCallId: toolCall.id, toolName: toolCall.name, args, content, details, isError: err }, sessionId, (r) => {
			out = { ...out };
			if (r.content) { content = r.content; out.content = r.content; }
			if (r.details !== undefined) { details = r.details; out.details = r.details; }
			if (typeof r.isError === "boolean") { err = r.isError; out.isError = r.isError; }
		});
		return out;
	}

	/** Built-in tools plus whatever server extensions add or replace. */
	toolDefs(): Record<string, ToolDef> {
		return this.ext ? this.ext.toolDefs() : TOOL_DEFS;
	}

	/** Per-run system prompt tweaks and the `context` hook, applied to what the model sees (never stored). */
	private async transformContext(sessionId: string, messages: AgentMessage[]): Promise<AgentMessage[]> {
		const live = this.live.get(sessionId);
		let out = messages;
		const sys = live?.runSystem;
		if (sys && out[0]?.role === "system") {
			const head = out[0] as { content?: unknown };
			const base = typeof head.content === "string" ? head.content : "";
			out = [{ ...out[0], content: `${sys.replace ?? base}${sys.append ?? ""}` } as AgentMessage, ...out.slice(1)];
		}
		out = withoutNotes(out);
		if (this.ext?.has("context")) {
			await this.ext.emit("context", { sessionId, messages: out }, sessionId, (r) => {
				if (Array.isArray(r.messages)) out = r.messages;
			});
		}
		return out;
	}

	private onAgentEvent(sessionId: string, live: Live, event: AgentEvent): void {
		this.forwardToExtensions(sessionId, event);
		const pub = (type: string, data: unknown, ephemeral = false) => this.bus.publish(sessionId, type, data, { ephemeral });

		switch (event.type) {
			case "message_update":
				pub("message_update", { message: undefined, event: slimAssistantEvent(event.assistantMessageEvent) }, true);
				return;
			case "tool_execution_update":
				pub("tool_execution_update", { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult }, true);
				return;
			case "message_end": {
				const seq = live.nextSeq++;
				// Remember the reasoning strength this reply was written with (the session's setting can change later).
				const st = live.agent.state;
				if (event.message.role === "assistant" && st.model?.reasoning && st.thinkingLevel && st.thinkingLevel !== "off") {
					(event.message as { thinkingLevel?: string }).thinkingLevel = st.thinkingLevel;
				}
				this.store.appendMessage(sessionId, seq, event.message);
				pub("message_end", { seq, message: event.message });
				this.ext?.notify("message_end", { sessionId, message: event.message, seq }, sessionId);
				return;
			}
			case "agent_end":
				pub("agent_end", { messageCount: event.messages.length });
				return;
			case "turn_end":
				pub(event.type, event);
				this.guardRunaway(sessionId, live, event);
				return;
			default:
				pub(event.type, event);
		}
	}

	private forwardToExtensions(sessionId: string, event: AgentEvent): void {
		const ext = this.ext;
		if (!ext) return;
		switch (event.type) {
			case "agent_start": ext.notify("agent_start", { sessionId }, sessionId); return;
			case "agent_end": ext.notify("agent_end", { sessionId, messageCount: event.messages.length }, sessionId); return;
			case "turn_start": ext.notify("turn_start", { sessionId }, sessionId); return;
			case "turn_end": ext.notify("turn_end", { sessionId, message: event.message }, sessionId); return;
			default: return;
		}
	}

	private async resolveModel(provider?: string, model?: string): Promise<{ provider: string; model: string }> {
		const defaults = this.registry.defaultSelection?.();
		const p = provider ?? defaults?.provider;
		const m = model ?? (!provider || provider === defaults?.provider ? defaults?.model : undefined);
		if (p && m) {
			if (!this.registry.models.getModel(p, m)) throw badRequest(`unknown model ${p}/${m}`);
			if (!(await this.registry.models.checkAuth(p))) throw badRequest(`provider ${p} is not configured; set its API key first`);
			return { provider: p, model: m };
		}
		const available = await this.registry.models.getAvailable(p);
		const pick = m ? available.find((x) => x.id === m) : available[0];
		if (!pick) {
			throw badRequest("no usable model is registered: add an endpoint and model via PUT /configuration/providers/:id, then save its API key if required");
		}
		return { provider: pick.provider, model: pick.id };
	}

	private resolveCwd(cwd?: string): string {
		const base = this.defaultWorkdir();
		const abs = resolve(base, cwd?.trim() || ".");
		if (this.cfg.restrictWorkspace && !isInside(this.cfg.workspaceRoot, abs)) {
			throw badRequest(`cwd must be inside the workspace (${this.cfg.workspaceRoot}): ${abs}`);
		}
		let found: ReturnType<typeof statSync> | undefined;
		try { found = statSync(abs); } catch { /* does not exist yet */ }
		if (found) {
			if (!found.isDirectory()) throw badRequest(`cwd is not a directory: ${abs}`);
			return abs;
		}
		// Only the default working directory grows new folders on demand; elsewhere a missing path is a typo.
		const rel = relative(base, abs);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw badRequest(`directory does not exist: ${abs}`);
		mkdirSync(abs, { recursive: true });
		return abs;
	}

	private validateTools(names: string[]): string[] {
		const defs = this.toolDefs();
		const unknown = names.filter((n) => !defs[n]);
		if (unknown.length) throw badRequest(`unknown tools: ${unknown.join(", ")}`);
		return [...new Set(names)];
	}

	private dispose(id: string): void {
		const live = this.live.get(id);
		if (!live) return;
		live.unsubscribe();
		this.live.delete(id);
	}

	private evictIdle(): void {
		const now = Date.now();
		for (const [id, live] of this.live) {
			if (!live.running && now - live.lastActive > IDLE_EVICT_MS) this.dispose(id);
		}
	}
}
