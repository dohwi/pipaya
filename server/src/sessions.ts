import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalManager } from "./approvals.ts";
import type { QuestionManager } from "./questions.ts";
import type { Config } from "./config.ts";
import { agentsPrompt, advertisedAgents, advertisedSkills, aggregateReadFiles, buildSystemPrompt, previewContext, type AdvertisedAgent, type ContextSnapshot, type SessionContext } from "./context.ts";
import { mentionedSkills, readSkillText, skillCallHint, skillsPrompt, type SkillRef, type SkillService } from "./skills.ts";
import { expandTemplate, parseTemplateCall, readTemplateBody, templateCallHint, type TemplateService } from "./templates.ts";
import { badRequest, conflict, HttpError, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { ModelRegistry } from "./models.ts";
import { agentHint, HINT_OPEN, mentionedAgents, type SubAgents } from "./subagent.ts";
import type { ModelChoiceValue } from "./model-choice.ts";
import { estimateTokens, pickCut, SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM, summaryMessage, summaryRequest, thresholdFor, type CompactionSettings } from "./compaction.ts";
import { type SessionPatch, type SessionRecord, type SessionStore, type ThinkingLevel } from "./store.ts";
import { buildTools, DEFAULT_TOOLS, isInside, isMutating, TOOL_DEFS, type ToolContext } from "./tools.ts";
import type { ApprovalPolicy } from "./config.ts";

export const DEFAULT_SYSTEM_PROMPT = `You are a capable coding assistant working inside a sandboxed working directory.
Use the available tools to inspect and change files and run commands. Prefer small, verifiable steps.
Be concise. Paths are relative to the working directory.`;

const IDLE_EVICT_MS = 30 * 60_000;

export type PromptMode = "prompt" | "steer" | "follow_up";

export interface CreateSessionInput {
	title?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	tools?: string[];
	approval?: ApprovalPolicy;
}

export interface SessionStatus {
	running: boolean;
	pendingToolCalls: string[];
	pendingApprovals: number;
	pendingQuestions: number;
	/** Partial assistant message for late-joining clients. */
	streamingMessage: AgentMessage | null;
	queued: boolean;
	lastError: string | null;
	/** A manual or automatic compaction is writing its summary. */
	compacting: boolean;
}

export interface CompactionOutcome {
	tokensBefore: number;
	context: { tokens: number | null; contextWindow: number };
	model: ModelChoiceValue & { custom: boolean };
}

interface Live {
	agent: Agent;
	nextSeq: number;
	running: boolean;
	runStartedAt: number;
	lastActive: number;
	unsubscribe: () => void;
	/** Fingerprint of the skills currently written into the system prompt. */
	skillsKey: string;
	/** Directories the read tool may open besides the cwd; mutated in place when skills change. */
	readRoots: string[];
	/** Set while a compaction runs; aborting it cancels the summary call. */
	compacting?: AbortController;
	/** Settles after the run's own wrap-up (run_finished) has been published, not just when the agent is idle. */
	settled?: Promise<void>;
	/** Runaway guard: model calls in this run, and the last tool-call fingerprints (to spot a repeating loop). */
	turns: number;
	recentCalls: string[];
	/** Set when abort did not take effect in time and the run was cut loose; its late wrap-up must stay silent. */
	forceStopped?: boolean;
}

/** How long a cooperative abort may take before the run is forcibly cut loose. */
const FORCE_STOP_MS = 8000;

/** A single run is stopped after this many model calls (a user can simply send another message to continue). */
const MAX_RUN_TURNS = Number(process.env.HARNESS_MAX_RUN_TURNS) > 0 ? Number(process.env.HARNESS_MAX_RUN_TURNS) : 200;
/** The same tool call (same name + arguments) this many turns in a row counts as a stuck loop. */
const MAX_REPEATED_CALLS = 6;

const skillsKey = (skills: SkillRef[], agents: AdvertisedAgent[] = []) =>
	JSON.stringify([skills.map((k) => [k.name, k.description, k.path]), agents.map((a) => [a.name, a.description])]);

/** Strip the heavy `partial` snapshot from stream deltas; clients rebuild from deltas. */
function slimAssistantEvent(e: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"]): unknown {
	const { partial: _partial, ...rest } = e as typeof e & { partial?: unknown };
	return rest;
}

export class SessionManager {
	private live = new Map<string, Live>();
	/** Runs that have not yet published run_finished. Tracked apart from `live`, which shutdown and delete empty first. */
	private pendingRuns = new Set<Promise<void>>();
	private sweeper: ReturnType<typeof setInterval>;

	constructor(
		private cfg: Config,
		private store: SessionStore,
		private bus: EventBus,
		private registry: ModelRegistry,
		private approvals: ApprovalManager,
		/** Where sessions start, and what relative cwd values resolve against. */
		private defaultWorkdir: () => string = () => cfg.workspaceRoot,
		private skills?: SkillService,
		private questions?: QuestionManager,
		private subagents?: SubAgents,
		private compaction?: CompactionSettings,
	) {
		this.sweeper = setInterval(() => this.evictIdle(), 5 * 60_000);
		this.sweeper.unref?.();
	}

	// ── CRUD ────────────────────────────────────────────────────────────────

	async create(input: CreateSessionInput, parentId: string | null = null): Promise<SessionRecord> {
		const { provider, model } = await this.resolveModel(input.provider, input.model);
		const tools = this.validateTools(input.tools ?? DEFAULT_TOOLS);
		const id = randomUUID();
		const cwd = this.resolveCwd(input.cwd);
		const now = Date.now();
		const record: SessionRecord = {
			id,
			title: input.title?.trim() || "New session",
			cwd,
			provider,
			model,
			thinkingLevel: input.thinkingLevel ?? this.registry.defaultSelection?.()?.thinkingLevel ?? "medium",
			systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
			tools,
			approval: input.approval ?? this.cfg.defaultApproval,
			parentId,
			closed: false,
			createdAt: now,
			updatedAt: now,
		};
		this.store.create(record);
		this.bus.publish(id, "session_created", record);
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

	/** Enabled sub-agents follow the current settings each turn, like skills. */
	private currentAgents(snapshot: Pick<ContextSnapshot, "tools" | "cwd">): AdvertisedAgent[] {
		return advertisedAgents(snapshot.tools, this.subagents?.agents(snapshot.cwd) ?? []);
	}

	context(id: string): SessionContext {
		const record = this.get(id);
		const snapshot = this.store.context(id);
		const base = snapshot ?? previewContext(record, this.skills?.active(record.cwd, id), undefined, this.subagents?.agents(record.cwd));
		const skills = snapshot ? this.currentSkills(id, snapshot) : (base.skills ?? []);
		const agents = (snapshot ? this.currentAgents(snapshot) : advertisedAgents(record.tools, this.subagents?.agents(record.cwd) ?? []))
			.map(({ name, description }) => ({ name, description }));
		return {
			...base,
			agents,
			skillsPrompt: skills.length ? skillsPrompt(skills) : "",
			agentsPrompt: agents.length ? agentsPrompt(agents) : "",
			effectiveSystemPrompt: snapshot ? buildSystemPrompt(snapshot.systemPrompt, snapshot.instructions, skills, this.currentAgents(snapshot)) : base.effectiveSystemPrompt,
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
			pendingApprovals: this.approvals.list(id).length,
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
		if (this.approvals.list(id).length || (this.questions?.list(id).length ?? 0)) throw conflict("the session is waiting for an answer; respond first");
		if (!this.compaction) throw new HttpError(501, "compaction_not_supported", "compaction is not available on this server");

		const stored = this.store.projection(id);
		const cutAt = pickCut(stored.messages.map((m) => m.message));
		if (cutAt === null) throw conflict("not enough history to compact yet");
		const toSummarize = stored.messages.slice(0, cutAt);
		const uptoSeq = toSummarize[toSummarize.length - 1]!.seq;

		const target = this.compaction.resolveModel(record);
		const model = this.registry.models.getModel(target.provider, target.model);
		if (!model) throw badRequest(`model ${target.provider}/${target.model} is not available`);
		if (!(await this.registry.models.checkAuth(target.provider))) throw badRequest(`provider ${target.provider} is not configured; set its API key first`);

		const before = this.contextUsage(id)?.tokens ?? 0;
		const controller = new AbortController();
		live.compacting = controller;
		this.bus.publish(id, "compaction_started", { reason });
		try {
			const reply = await this.registry.models.completeSimple(
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
		}
	}

	/** Before a prompt: compact first when automatic compaction is on and the context is nearly full. */
	private async autoCompact(id: string): Promise<void> {
		if (!this.compaction?.get().auto) return;
		const usage = this.contextUsage(id);
		if (!usage?.tokens || usage.tokens < thresholdFor(usage.contextWindow)) return;
		try {
			await this.compact(id, undefined, "threshold");
		} catch { /* the prompt still goes out; compact() already published why it did not happen */ }
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
				approval: src.approval,
			},
			src.id,
		);
		const copied = this.store.copyMessages(id, copy.id, atSeq);
		this.bus.publish(copy.id, "session_forked", { from: id, atSeq: atSeq ?? null, messages: copied });
		return this.get(copy.id);
	}

	// ── Running ─────────────────────────────────────────────────────────────

	async send(
		id: string,
		input: { text: string; images?: ImageContent[]; mode?: PromptMode },
	): Promise<{ accepted: "prompt" | "steer" | "follow_up" }> {
		const record = this.get(id);
		if (record.closed) throw conflict("session is closed; resume it first (PATCH closed=false)");
		const mode = input.mode ?? "prompt";
		const active = this.live.get(id)?.running ?? false;
		if (mode !== "prompt" && !active) throw conflict(`session is idle; use mode "prompt" (mode "${mode}" needs an active run)`);
		if (mode === "prompt" && active) throw conflict('session is busy; send with mode "steer" or "follow_up"');
		const live = this.ensureLive(record);
		if (live.compacting) throw conflict("the session is being compacted; send after it finishes");

		const content: ({ type: "text"; text: string } | ImageContent)[] = [{ type: "text", text: input.text }];
		const asked = mentionedAgents(input.text, this.subagents?.agents(record.cwd).map((a) => a.name) ?? []);
		if (asked.length) content.push({ type: "text", text: agentHint(asked) });
		if (this.skills) {
			const callable = this.skills.callable(record.cwd, id);
			for (const name of mentionedSkills(input.text, callable.map((s) => s.name))) {
				const skill = callable.find((s) => s.name === name)!;
				const body = readSkillText(skill.path);
				if (body !== null) content.push({ type: "text", text: skillCallHint(skill, body, HINT_OPEN) });
			}
		}
		if (input.images?.length) content.push(...input.images);
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };

		if (mode === "steer" || mode === "follow_up") {
			if (!live.running) throw conflict(`session is idle; use mode "prompt" (mode "${mode}" needs an active run)`);
			if (mode === "steer") live.agent.steer(message);
			else live.agent.followUp(message);
			this.bus.publish(id, "message_queued", { mode, text: input.text });
			return { accepted: mode };
		}

		if (live.running) throw conflict('session is busy; send with mode "steer" or "follow_up"');
		if (record.title === "New session" && this.store.nextSeq(id) === 0) {
			this.update(id, { title: input.text.trim().replace(/\s+/g, " ").slice(0, 60) || "New session" });
		}
		this.run(id, live, "prompt", async () => { await this.autoCompact(id); await live.agent.prompt(message); });
		return { accepted: "prompt" };
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
		for (const [id, live] of this.live) {
			if (live.running) live.agent.abort();
			this.dispose(id);
		}
	}

	/** Live state of every session that is running or waiting on the user (idle sessions are omitted). */
	activity(): { sessionId: string; running: boolean; pendingApprovals: number; pendingQuestions: number }[] {
		type Row = { sessionId: string; running: boolean; pendingApprovals: number; pendingQuestions: number };
		const out = new Map<string, Row>();
		const row = (sessionId: string): Row => {
			let e = out.get(sessionId);
			if (!e) out.set(sessionId, (e = { sessionId, running: false, pendingApprovals: 0, pendingQuestions: 0 }));
			return e;
		};
		for (const [sessionId, l] of this.live) if (l.running) row(sessionId).running = true;
		for (const r of this.approvals.list()) row(r.sessionId).pendingApprovals++;
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
			}
			return existing;
		}

		const model = this.registry.models.getModel(record.provider, record.model);
		if (!model) throw badRequest(`model ${record.provider}/${record.model} is not available`);

		const history = this.projectedMessages(record.id);
		const snapshot = this.store.context(record.id) ?? this.store.captureContext(record.id, {
			...previewContext(record, this.skills?.active(record.cwd, record.id), undefined, this.subagents?.agents(record.cwd)), capturedAt: Date.now(),
		});
		const skills = this.currentSkills(record.id, snapshot);
		const agents = this.currentAgents(snapshot);
		const readRoots = skills.map((k) => k.baseDir);
		const agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(snapshot.systemPrompt, snapshot.instructions, skills, agents),
				model,
				thinkingLevel: record.thinkingLevel,
				tools: buildTools(snapshot.tools, snapshot.cwd, readRoots, this.toolContext(record.id)),
				messages: history,
			},
			streamFn: this.registry.models.streamSimple.bind(this.registry.models),
			sessionId: record.id,
			beforeToolCall: async ({ toolCall, args }, signal) => this.gateTool(record.id, toolCall.id, toolCall.name, args, signal),
		});

		const live: Live = {
			agent,
			nextSeq: this.store.nextSeq(record.id),
			running: false,
			runStartedAt: 0,
			lastActive: Date.now(),
			unsubscribe: () => {},
			skillsKey: skillsKey(skills, agents),
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
		const agents = this.currentAgents(snapshot);
		const key = skillsKey(skills, agents);
		if (key === live.skillsKey) return;
		const [head, ...rest] = live.agent.state.messages;
		if (head?.role === "system") {
			live.agent.state.messages = [{ ...head, content: buildSystemPrompt(snapshot.systemPrompt, snapshot.instructions, skills, agents) } as AgentMessage, ...rest];
		}
		live.readRoots.splice(0, live.readRoots.length, ...skills.map((k) => k.baseDir));
		live.skillsKey = key;
	}

	/** What tools may ask of the running session. `ask` only exists when a QuestionManager is wired in. */
	private toolContext(sessionId: string): ToolContext {
		const q = this.questions;
		const sub = this.subagents;
		const ctx: ToolContext = q ? { ask: (toolCallId, req, signal) => q.ask({ sessionId, toolCallId, ...req }, signal) } : {};
		if (sub) {
			// A helper with no model of its own runs on this session's current model.
			ctx.delegateAgents = () => sub.agents(this.store.get(sessionId)?.cwd);
			ctx.delegate = async (req) => {
				const rec = this.store.get(sessionId);
				if (!rec) throw notFound("session");
				return sub.run({ ...req, fallback: { provider: rec.provider, model: rec.model } });
			};
		}
		return ctx;
	}

	/** Approval policy lives here so it applies to every client. Reads policy fresh from the DB. */
	private async gateTool(sessionId: string, toolCallId: string, toolName: string, args: unknown, signal?: AbortSignal) {
		const policy = this.store.get(sessionId)?.approval ?? "ask";
		const delegated = toolName === "delegate" && !!this.subagents?.mutates((args as { agent?: string } | null)?.agent, this.store.get(sessionId)?.cwd ?? "");
		if (!(isMutating(toolName) || delegated) || policy === "auto") return undefined;
		if (policy === "readonly") {
			return { block: true, reason: `"${toolName}" is disabled: this session is read-only` };
		}
		const decision = await this.approvals.request({ sessionId, toolCallId, toolName, args }, signal);
		return decision.approved ? undefined : { block: true, reason: decision.reason ?? `The user denied "${toolName}"` };
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

	private onAgentEvent(sessionId: string, live: Live, event: AgentEvent): void {
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
				this.store.appendMessage(sessionId, seq, event.message);
				pub("message_end", { seq, message: event.message });
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
		const unknown = names.filter((n) => !TOOL_DEFS[n]);
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
