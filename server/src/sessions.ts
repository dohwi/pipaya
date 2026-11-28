import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, isContextOverflow, toToolDeclaration, type ImageContent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { askQuestion, type QuestionManager } from "./questions.ts";
import { DEFAULT_MAX_SESSIONS, type Config } from "./config.ts";
import { advertisedSkills, aggregateReadFiles, buildEnvContext, buildSystemPrompt, discoverInstructions, previewContext, type ContextSnapshot, type ContextTool, type SessionContext, type SystemPromptEntry } from "./context.ts";
import { createContextPruneState, pruneOldToolResults, resetContextPruneState } from "./context-pruning.ts";
import { systemPromptEntries } from "./system-prompts.ts";
import { mentionedSkills, readSkillText, skillCallHint, skillsPrompt, type SkillRef, type SkillService } from "./skills.ts";
import { badRequest, conflict, HttpError, notFound } from "./errors.ts";
import { filesNote, inlineImagesHint, saveInlineImages, saveUploads } from "./routes/file-routes.ts";
import type { EventBus } from "./events.ts";
import { checkServiceTier, modelDefaultTier, modelDefaultLevel, reasoningOption, type ModelRegistry } from "./models.ts";
import { streamAtTier } from "./served-tier.ts";
import type { ServiceTier } from "./openrouter-catalog.ts";
import { attachTouchedFiles, completeSummaryWithShrinkRetry, contextTokens, effectiveContextTokens, estimateTokens, KEEP_RECENT_TOKENS, pickCut, SUMMARY_MAX_TOKENS, summaryMessage, thresholdFor, type CompactionSettings } from "./compaction.ts";
import { THINKING_LEVELS, type DelegateCall, type SessionPatch, type SessionRecord, type SessionStore, type ThinkingLevel } from "./store.ts";
import type { McpManager } from "./mcp.ts";
import { ALWAYS_TOOLS, buildTools, DEFAULT_TOOLS, DELEGATE_TOOL, isInside, modelList, PEER_TOOLS, TOOL_DEFS, WORKDIR_TOOL, type ReadTrackEntry, type ToolContext, type ToolDef } from "./tools.ts";
import { isGone, workDirOf } from "./work-tree.ts";
import { SessionWorkdirs } from "./session-workdirs.ts";
import { SessionDescriber } from "./session-describer.ts";
import { GOAL_TOOL } from "./goal-tool.ts";
import type { GoalManager } from "./goals.ts";
import { MCP_TOOL } from "./mcp-tool.ts";
import { SCHEDULE_TOOL } from "./schedule-tool.ts";
import type { Scheduler } from "./scheduler.ts";
import { sameName } from "./member-names.ts";
import { HINT_OPEN, PeerService, type GroupOps, type GroupRef } from "./peers.ts";
import type { QuestionRequest } from "./questions.ts";
import type { ExtensionHost } from "./extensions/host.ts";
import type { MessageNote } from "./extensions/types.ts";
import { IMAGE_TOOL, imageTool, type ImageModelSettings } from "./image-generation.ts";
import { fitImagesInContext } from "./image-guard.ts";
import { stripOversizedToolResultImages, stripToolMessageImages, stripToolResultImages } from "./tool-images.ts";
import { describeTools, enabledTools, planTools } from "./tool-plan.ts";
import { afterTurn, FORCE_STOP_ERROR, hasAssistantOutputOrTools, isEmptyFailedReply, RESTART_RUN_ERROR, RESTART_TOOL_ERROR, runawayReason, SHUTDOWN_RUN_ERROR, SHUTDOWN_TOOL_ERROR, type RunStopCause } from "./run-guard.ts";
import { capSubagentOutput, chooseModel, DelegateLimits, finalText, freeRole, repeatedToolSignature, runDelegateWithinDeadline, subagentReport, subagentReportReserveMs, subagentUsage, loadSubagents, SUBAGENT_NAME, SUBAGENT_TIMEOUT_MS, SUBAGENT_WRAP_UP, subagentSystem, type SubagentDef, type SubagentLimit } from "./subagents.ts";
import { COMPLETION_RETRY, completeWithUpstreamRetry, DEFAULT_UPSTREAM_RETRY, isZeroOutputError, retryReason, sleepAbortable, withUpstreamRetry } from "./upstream-retry.ts";
import { recoverWithFallback, retryDroppedMidStream } from "./stream-runner.ts";
import { autoTitle, type SystemModelSettings } from "./system-model.ts";
import type { FallbackModelSettings } from "./fallback-model.ts";
import type { GuardSettings } from "./guard.ts";
import { runPromptTemplate } from "./templates.ts";

import { DEFAULT_DELEGATE_POLICY, type DelegatePolicyValue } from "./configuration.ts";
import { DEFAULT_SYSTEM_PROMPT, FORCE_STOP_MS, IDLE_EVICT_MS, MAX_REPEATED_CALLS, MAX_RUN_TURNS, promptKey, SHUTDOWN_STOP_MS, type CompactionOutcome, type CreateSessionInput, type Deferred, type Live, type PromptMode, type RecallCandidate, type RunOrigin, type SessionStatus } from "./session-types.ts";
import { agentQueue, GOAL_NOTE, interruptedAssistantMessage, interruptedToolResult, noteBlock, queuedIn, queuedText, rewriteShutdownToolText, SCHEDULE_NOTE, sentText, slimAssistantEvent, unresolvedToolCalls, withoutNotes, type Waiting } from "./session-helpers.ts";
export { DEFAULT_SYSTEM_PROMPT } from "./session-types.ts";
export { GOAL_OPEN, NOTE_OPEN, noteBlock, SCHEDULE_OPEN } from "./session-helpers.ts";
export type { CompactionOutcome, CreateSessionInput, PromptMode, SessionStatus } from "./session-types.ts";

/** Minimum context size before repeated zero-output failures trigger an automatic compaction pass. */
const ZERO_OUTPUT_COMPACT_MIN_TOKENS = 32_000;


/** Why a chat cannot use an image model (also shown to the user as the error). */
const IMAGE_MODEL_IN_CHAT = "this is an image model: it does not chat. Pick a chat model, and set this one as the image model in the settings so agents can draw with the generate_image tool";

/** Errors compact() has already published as compaction_failed. */
const reported = new WeakSet<object>();

/** A `delegate` call as the graph view shows it (see `SessionManager.delegateRuns`). */
export type DelegateRun = DelegateCall & { free: boolean; running: boolean; model: string };

export class SessionManager {
	private live = new Map<string, Live>();
	/** Sessions whose last run was stopped from outside (until the next run starts); outlives a forced stop's dispose. */
	private stopped = new Set<string>();
	/** Runs that have not yet published run_finished. Tracked apart from `live`, which shutdown and delete empty first. */
	private pendingRuns = new Set<Promise<void>>();
	/** Accepted sends keyed by `sessionId\0clientRequestId` so retries after a lost ACK do not duplicate prompts. */
	private recentSends = new Map<string, { accepted: PromptMode; at: number }>();
	private inflightSends = new Map<string, Promise<{ accepted: PromptMode }>>();
	/** Background title/role generation and git worktree operations. */
	private describer: SessionDescriber;
	private workdirOps: SessionWorkdirs;
	/** `delegate` use per session: calls in the current run and subagents running right now. */
	private delegates = new DelegateLimits();
	/** Chat models usable now (provider/model), for the tool texts; refreshed before a run is set up, at most every few seconds. */
	private chatModelIds: string[] = [];
	private chatModelsAt = 0;
	private closing = false;
	private sweeper: ReturnType<typeof setInterval>;
	/** Names, messages between sessions and `@name` hints. */
	readonly peers: PeerService;
	/** Session ids of every group, wired by the app once the group manager exists. */
	private groupSource: () => GroupRef[] = () => [];

	setGroupSource(fn: () => GroupRef[]): void {
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
		systemModel?: SystemModelSettings,
		/** The image model; while one is set every session gets the generate_image tool. */
		private imageModel?: ImageModelSettings,
		/** MCP servers; the tools of the connected ones reach every session. */
		private mcp?: McpManager,
		/** Home directory whose `.agents/subagents` holds the global subagent roles; defaults to the OS user home. */
		private home: string = homedir(),
		/** The user's rules for subagents: which models `delegate` may pick and the limits. */
		private delegatePolicy: () => DelegatePolicyValue = () => DEFAULT_DELEGATE_POLICY,
		/** Subagent roles the user switched off (`scope/name`); `delegate` treats them as missing. */
		private disabledSubagents: () => string[] = () => [],
		private delegateTimeoutMs = SUBAGENT_TIMEOUT_MS,
		/** Built-in bash command guard. */
		private guard?: GuardSettings,
		/** Deadline for runs to settle during `shutdown()` before being forcibly finalized as errors. */
		private shutdownStopMs = SHUTDOWN_STOP_MS,
		/** Optional automatic fallback model used when the primary model repeatedly fails with zero output. */
		private fallbackModel?: FallbackModelSettings,
	) {
		this.sweeper = setInterval(() => this.evictIdle(), 5 * 60_000);
		this.sweeper.unref?.();
		this.describer = new SessionDescriber({
			store,
			registry,
			systemModel,
			takenNames: () => this.peers.taken(),
			isClosing: () => this.closing,
			updateSession: (id, patch) => this.update(id, patch, { automatic: true }),
		});
		this.workdirOps = new SessionWorkdirs({
			store,
			bus,
			getSession: (id) => this.get(id),
			isRunning: (id) => this.isRunning(id),
			allowedDir: (dir) => !this.cfg.restrictWorkspace || isInside(this.cfg.workspaceRoot, dir),
			home: this.home,
		});
		this.peers = new PeerService({
			store,
			groups: () => this.groupSource(),
			isRunning: (id) => this.isRunning(id),
			deliver: (id, text, mode) => this.send(id, { text, mode, origin: "peer" }),
			rename: (id, name) => void this.update(id, { name }),
			abort: (id) => this.abort(id),
			onRunFinished: (fn) => {
				this.bus.subscribe((e) => {
					if (e.type === "run_finished" && e.sessionId) fn(e.sessionId, e.data as { status?: string; error?: string | null });
				});
			},
			onQuestion: (fn) => {
				this.bus.subscribe((e) => {
					if (e.type === "question_requested" && e.sessionId) fn(e.sessionId, e.data as QuestionRequest);
				});
			},
			onQuestionResolved: (fn) => {
				this.bus.subscribe((e) => {
					if (e.type === "question_resolved" && e.sessionId) {
						const toolCallId = (e.data as { toolCallId?: string } | undefined)?.toolCallId;
						if (toolCallId) fn(e.sessionId, toolCallId);
					}
				});
			},
			questions: (id) => this.questions?.list(id) ?? [],
			answer: (id, toolCallId, a) => this.questions?.answer(id, toolCallId, a) ?? "not_found",
			create: (input, parentId) => this.create(input, parentId),
			update: (id, patch) => void this.update(id, patch),
			remove: (id) => this.delete(id),
			cancelQueued: (id, mode, text) => this.cancelQueued(id, mode, text),
			queued: (id) => this.queuedOf(id),
			groupOps: {
				create: (name, ids) => this.groupOps.create(name, ids),
				add: (g, ids) => this.groupOps.add(g, ids),
				remove: (g, ids) => this.groupOps.remove(g, ids),
				dissolve: (g) => this.groupOps.dissolve(g),
			},
		});
		if (this.cfg.dataDir) void this.sweepOrphanSpills();
	}

	/** Group changes for `peer(action=group_*)`, wired by the app once the group manager exists. */
	private groupOps: GroupOps = {
		create: () => { throw conflict("groups are not available"); },
		add: () => { throw conflict("groups are not available"); },
		remove: () => { throw conflict("groups are not available"); },
		dissolve: () => { throw conflict("groups are not available"); },
	};

	setGroupOps(ops: GroupOps): void {
		this.groupOps = ops;
	}

	/** Scheduled tasks for the `schedule` tool, wired by the app once the scheduler exists. */
	private scheduler?: Scheduler;
	private goals?: GoalManager;

	setScheduler(s: Scheduler): void {
		this.scheduler = s;
	}

	setGoals(g: GoalManager): void {
		this.goals = g;
	}

	private goalOps(selfId: string): ToolContext["goals"] {
		const g = this.goals;
		if (!g) return undefined;
		return {
			get: () => g.get(selfId),
			create: (objective, tokenBudget) => g.agentCreate(selfId, objective, tokenBudget),
			update: (status) => g.agentUpdate(selfId, status),
		};
	}

	private mcpOps(): ToolContext["mcp"] {
		const m = this.mcp;
		if (!m) return undefined;
		return {
			info: () => m.info(),
			add: (server) => m.add(server),
			patch: (name, patch) => m.patch(name, patch),
			remove: (name) => m.remove(name),
			reload: (name) => m.reload(name),
			waitFor: (name, timeoutMs, signal) => m.waitFor(name, timeoutMs, signal),
		};
	}

	/** Called when the server's MCP tool set changes so active runs pick up added/removed MCP tools on their next turn. */
	notifyMcpToolsChanged(): void {
		for (const live of this.live.values()) live.toolsDirty = true;
	}

	/** What `schedule` may do, on behalf of session `selfId`. */
	private scheduleOps(selfId: string): ToolContext["schedules"] {
		const s = this.scheduler;
		if (!s) return undefined;
		const target = (name?: string) => {
			const n = name?.trim().replace(/^@/, "");
			if (!n) return selfId;
			const active = this.store.list({ limit: 1000, closed: false }).filter((r) => r.name);
			const hit = active.find((r) => sameName(r.name, n));
			if (!hit) throw notFound(`session @${n} (sessions: ${active.map((r) => `@${r.name}`).join(", ") || "none"})`);
			return hit.id;
		};
		return {
			list: (all) => s.list(all ? undefined : selfId),
			create: ({ session, title, prompt, runAt, everyMs }) =>
				s.create({ sessionId: target(session), title, prompt, ...(runAt !== undefined ? { kind: "once", runAt } : { kind: "interval", everyMs }) }, { createdBySessionId: selfId }),
			update: (id, patch) => s.update(id, patch),
			delete: (id) => {
				const t = s.get(id);
				s.delete(id);
				return t;
			},
			run: (id) => s.runNow(id),
			createdBy: (id) => s.createdBy(id),
			label: (id) => {
				if (id === selfId) return "this session";
				const r = this.store.get(id);
				return r?.name ? `@${r.name}${r.closed ? " (closed)" : ""}` : id;
			},
			now: () => Date.now(),
		};
	}

	/** Messages still waiting in a session's steer / follow-up queues (pi-agent-core keeps them in plain arrays). */
	private queuedOf(id: string): Waiting[] {
		const live = this.live.get(id);
		return live ? queuedIn(live) : [];
	}

	/**
	 * A stopped run takes nothing more: drop every message still waiting for it (steers, follow-ups and what the server
	 * holds behind a queued /compact) and say so per message, so the client that queued one can hand it back to its input.
	 * pi-agent-core keeps its queues across abort(), so without this they would ride along with the next message.
	 */
	private dropQueued(id: string, live: Live): void {
		const dropped = queuedIn(live);
		live.agent.clearAllQueues();
		live.deferred = [];
		for (const q of dropped) this.bus.publish(id, "message_dequeued", { mode: q.mode, text: q.text, ...(q.deferred ? { deferred: true } : {}), reason: "stopped" });
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
		this.assertChatModel(provider, model);
		const tools = this.validateTools(input.tools ?? this.ext?.defaultTools() ?? DEFAULT_TOOLS);
		const id = randomUUID();
		const cwd = this.resolveCwd(input.cwd);
		const now = Date.now();
		const serviceTier = input.serviceTier !== undefined ? input.serviceTier : this.startingTier(provider, model);
		if (serviceTier) await checkServiceTier(this.registry, provider, model, serviceTier);
		const record: SessionRecord = {
			serviceTier,
			id,
			title: input.title?.trim() || "New session",
			name: this.peers.newName(parentId),
			purpose: "",
			cwd,
			provider,
			model,
			thinkingLevel: input.thinkingLevel ?? this.defaultThinkingLevel(provider, model),
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

	/** AGENTS.md files are re-read from disk on every use, like skills: edits apply from the next run. */
	private currentInstructions(snapshot: Pick<ContextSnapshot, "cwd">) {
		return discoverInstructions(snapshot.cwd);
	}

	/** Skills always follow the current on/off settings. */
	private currentSkills(id: string, snapshot: Pick<ContextSnapshot, "cwd" | "tools">): SkillRef[] {
		return advertisedSkills(snapshot.tools, this.skills?.active(snapshot.cwd, id) ?? []);
	}

	context(id: string, auth: { anthropicOAuth?: boolean } = {}): SessionContext {
		const record = this.get(id);
		const snapshot = this.store.context(id);
		const base = snapshot ?? previewContext(record, this.skills?.active(record.cwd, id), undefined);
		const skills = snapshot ? this.currentSkills(id, snapshot) : (base.skills ?? []);
		const { instructions, warnings } = snapshot ? this.currentInstructions(snapshot) : base;
		const cacheStats = this.live.get(id)?.cacheStats;
		return {
			...base,
			instructions,
			warnings,
			skillsPrompt: skills.length ? skillsPrompt(skills) : "",
			effectiveSystemPrompt: buildSystemPrompt(
				snapshot ? snapshot.systemPrompt : base.systemPrompt,
				instructions,
				skills,
				buildEnvContext(snapshot ? snapshot.cwd : base.cwd),
			),
			// baseDir is an internal read allow-list entry, not part of the API.
			skills: skills.map(({ name, description, path, scope }) => ({ name, description, path, scope })),
			state: snapshot ? "applied" : "preview",
			capturedAt: snapshot?.capturedAt ?? null,
			toolSpecs: this.toolSpecs(base.tools, workDirOf(record)),
			systemPrompts: this.systemPromptList(record.provider, record.model, auth.anthropicOAuth),
			readFiles: aggregateReadFiles(record.cwd, this.store.toolResults(id, "read")),
			...(cacheStats && cacheStats.turns > 0 ? { cache: { ...cacheStats } } : {}),
		};
	}

	/** What a new conversation in `cwd` would start with, before any session exists (the composer of a new chat). */
	previewContext(cwdInput?: string): SessionContext {
		const cwd = this.skills?.resolveCwd(cwdInput) ?? resolve(this.defaultWorkdir(), cwdInput?.trim() || ".");
		const tools = this.ext?.defaultTools() ?? DEFAULT_TOOLS;
		const base = previewContext({ cwd, tools, systemPrompt: DEFAULT_SYSTEM_PROMPT } as SessionRecord, this.skills?.active(cwd), undefined);
		const skills = base.skills ?? [];
		return {
			...base,
			effectiveSystemPrompt: buildSystemPrompt(base.systemPrompt, base.instructions, skills, buildEnvContext(cwd)),
			skillsPrompt: skills.length ? skillsPrompt(skills) : "",
			skills: skills.map(({ name, description, path, scope }) => ({ name, description, path, scope })),
			state: "preview",
			capturedAt: null,
			toolSpecs: this.toolSpecs(tools, cwd),
			systemPrompts: this.systemPromptList(),
			readFiles: [],
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
			queued: (live?.agent.hasQueuedMessages() ?? false) || !!live?.deferred?.length,
			queuedMessages: this.queuedOf(id),
			lastError: live?.agent.state.errorMessage ?? null,
			compacting: !!live?.compacting,
		};
	}

	/** Tokens the next model request will carry (last real usage + estimate of what followed) against the model's window. */
	contextUsage(id: string): { tokens: number | null; contextWindow: number } | null {
		const record = this.get(id);
		const model = this.registry.models.getModel(record.provider, record.model);
		if (!model) return null;
		const live = this.live.get(id);
		const messages = live ? live.agent.state.messages : this.projectedMessages(id);
		const systemChars = live ? live.agent.state.systemPrompt.length : 0;
		return { tokens: contextTokens(messages, systemChars, this.store.latestCompaction(id)?.createdAt), contextWindow: model.contextWindow };
	}

	/** Always-numeric token estimate used for automatic compaction thresholds (never null after compaction). */
	private effectiveContextUsage(id: string): { tokens: number; contextWindow: number } | null {
		const record = this.get(id);
		const model = this.registry.models.getModel(record.provider, record.model);
		if (!model) return null;
		const live = this.live.get(id);
		const messages = live ? live.agent.state.messages : this.projectedMessages(id);
		const systemChars = live ? live.agent.state.systemPrompt.length : 0;
		return { tokens: effectiveContextTokens(messages, systemChars, this.store.latestCompaction(id)?.createdAt), contextWindow: model.contextWindow };
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
		const cutAt = pickCut(stored.messages.map((m) => m.message), KEEP_RECENT_TOKENS, reason === "threshold" && live.running, reason === "manual");
		if (cutAt === null) throw conflict("not enough history to compact yet");
		const toSummarize = stored.messages.slice(0, cutAt).map((m) => ({ ...m, message: withoutNotes([m.message])[0]! }));
		const uptoSeq = toSummarize[toSummarize.length - 1]!.seq;

		const target = this.compaction.resolveModel(record);
		const model = this.registry.models.getModel(target.provider, target.model);
		if (!model) throw badRequest(`model ${target.provider}/${target.model} is not available`);
		if (!(await this.registry.models.checkAuth(target.provider))) throw badRequest(`provider ${target.provider} is not configured; set its API key first`);

		const before = this.contextUsage(id)?.tokens ?? this.effectiveContextUsage(id)?.tokens ?? 0;
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
			const toSummarizeMessages = toSummarize.map((m) => m.message);
			const summaryOptions = { maxTokens: SUMMARY_MAX_TOKENS, signal: controller.signal, ...reasoningOption(target.thinkingLevel, model) };
			const reply = custom !== undefined
				? ({ stopReason: "stop", content: [{ type: "text", text: custom }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } as unknown as Awaited<ReturnType<typeof this.registry.models.completeSimple>>)
				: await completeSummaryWithShrinkRetry(
					(summaryContext) => completeWithUpstreamRetry(
						(ctx) => this.registry.models.completeSimple(model, ctx, summaryOptions),
						summaryContext,
						COMPLETION_RETRY,
						controller.signal,
						(attempt, maxRetries, delayMs, errorMessage) => {
							console.warn(`[compaction] session=${id} retry ${attempt}/${maxRetries} in ${delayMs}ms: ${retryReason(errorMessage) || errorMessage || "upstream error"}`);
						},
					),
					{
						previousSummary: stored.summary,
						messages: toSummarizeMessages,
						instructions,
						contextWindow: model.contextWindow,
						signal: controller.signal,
						onShrinkRetry: ({ attempt, maxRetries, reason: shrinkReason, previousChars, nextChars }) => {
							console.warn(`[compaction] session=${id} shrink retry ${attempt}/${maxRetries} (${shrinkReason}): ${previousChars} -> ${nextChars} chars`);
						},
					},
				);
			if (reply.stopReason === "aborted" || controller.signal.aborted) throw Object.assign(new Error("compaction cancelled"), { aborted: true });
			if (reply.stopReason === "error") throw new Error(reply.errorMessage || "the summary model failed");
			if (reply.stopReason === "length") throw new Error("the summary was truncated at the output token limit");
			const rawSummary = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
			if (!rawSummary) throw new Error("the summary model returned nothing");
			const summary = attachTouchedFiles(rawSummary, toSummarizeMessages, stored.summary);
			// The transcript may have grown while the summary was written; only what was summarized is replaced.
			const u = reply.usage;
			this.store.addCompaction(id, {
				uptoSeq, summary, tokensBefore: before,
				usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: u.cost.total },
			});
			resetContextPruneState(live.pruneState);
			const head = live.agent.state.messages[0];
			const projected = this.projectedMessages(id);
			live.agent.state.messages = head?.role === "system" ? [head, ...projected] : projected;
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
			const err = aborted ? conflict("compaction cancelled") : e instanceof HttpError ? e : new HttpError(502, "upstream_error", errorMessage);
			reported.add(err);
			throw err;
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
		const usage = this.effectiveContextUsage(id);
		if (!usage || usage.tokens < thresholdFor(usage.contextWindow, settings.thresholdPercent)) return;
		try {
			await this.compact(id, undefined, "threshold");
		} catch { /* the prompt still goes out; compact() already published why it did not happen */ }
	}

	/**
	 * Between the turns of one run (a long task of many tool calls never passes `autoCompact`, which only runs before a
	 * prompt): compact when the context has reached the threshold and hand the loop the shortened transcript.
	 */
	private async compactMidRun(id: string, tools: AgentTool<any>[] | undefined): Promise<{ context: { messages: AgentMessage[]; tools?: AgentTool<any>[] } } | undefined> {
		const settings = this.compaction?.get();
		if (!settings?.auto) return undefined;
		const usage = this.effectiveContextUsage(id);
		if (!usage || usage.tokens < thresholdFor(usage.contextWindow, settings.thresholdPercent)) return undefined;
		try {
			await this.compact(id, undefined, "threshold");
		} catch { return undefined; } // compact() already published why; the run goes on with the full context
		const live = this.live.get(id);
		return live ? { context: { messages: live.agent.state.messages.slice(), tools } } : undefined;
	}

	async configureSession(id: string, patch: SessionPatch): Promise<SessionRecord> {
		if (patch.serviceTier) {
			const current = this.get(id);
			const { provider, model } = this.splitSpec(patch.provider, patch.model ?? current.model, current.provider);
			await checkServiceTier(this.registry, provider ?? current.provider, model ?? current.model, patch.serviceTier);
			patch = { ...patch, provider: provider ?? current.provider, model: model ?? current.model };
		}
		return this.update(id, patch);
	}

	update(id: string, patch: SessionPatch, options?: { automatic?: boolean }): SessionRecord {
		const current = this.get(id);
		if (patch.model !== undefined && patch.provider === undefined) patch = { ...patch, ...this.splitSpec(undefined, patch.model, current.provider) };
		const clean: SessionPatch = { ...patch };

		if (patch.provider !== undefined || patch.model !== undefined) {
			const provider = patch.provider ?? current.provider;
			const model = patch.model ?? current.model;
			// A new model starts at the speed a new chat with it would: the speed never carries over to a model that may not offer it.
			if (patch.serviceTier === undefined && (model !== current.model || provider !== current.provider)) clean.serviceTier = this.startingTier(provider, model);
			if (!this.registry.models.getModel(provider, model)) throw badRequest(`unknown model ${provider}/${model}${this.availableModelsHint()}`);
			this.assertChatModel(provider, model);
		}
		if (patch.tools !== undefined || patch.systemPrompt !== undefined) {
			// The prompt and tool declarations are baked into the transcript head; changing them
			// after the first message would desynchronise a reloaded session from its history.
			if (this.store.nextSeq(id) > 0 || this.store.context(id)) {
				throw conflict("systemPrompt and tools can only change before the first message; fork the session instead");
			}
			if (patch.tools) clean.tools = this.validateTools(patch.tools);
		}

		if (patch.closed === false && current.closed) {
			this.assertRoom();
			// A closed session keeps its name (nobody else may take it), so on resume it has it again.
			clean.name = this.peers.resumedName(current);
		}
		const updated = this.store.update(id, clean);
		if (!updated) throw notFound("session");
		if (!options?.automatic) {
			const titleChanged = clean.title !== undefined && clean.title !== current.title;
			const purposeChanged = clean.purpose !== undefined && clean.purpose !== current.purpose;
			if (titleChanged || purposeChanged) {
				this.describer.markManual(id, {
					title: titleChanged,
					purpose: purposeChanged && clean.purpose !== "",
					purposeCleared: purposeChanged && clean.purpose === "",
				});
			}
		}

		const live = this.live.get(id);
		if (patch.closed) {
			if (live?.running) this.abortRun(id, live, "close"); // closing stops the work
			this.goals?.onSessionClosed(id);
		}
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

	/**
	 * Where a new chat with this model starts: the model's own default (chosen in its connection settings), else the
	 * saved default model's strength when it is this very model, else "medium".
	 */
	private defaultThinkingLevel(provider: string, model: string): ThinkingLevel {
		const live = this.registry.models.getModel(provider, model);
		const own = live ? modelDefaultLevel(live) : undefined;
		if (own) return own;
		const saved = this.registry.defaultSelection?.();
		return saved && saved.provider === provider && saved.model === model && saved.thinkingLevel ? saved.thinkingLevel : "medium";
	}

	/**
	 * The speed a chat on this model starts at: the saved new-chat choice when it is this very model (null there means
	 * "OpenRouter's own routing" and must not fall through to a paid default), else the model's own default. Both were
	 * checked against the catalog when they were saved.
	 */
	private startingTier(provider: string, model: string): ServiceTier | null {
		const saved = this.registry.defaultSelection?.();
		const chosen = saved?.provider === provider && saved.model === model ? saved.serviceTier : undefined;
		return chosen !== undefined ? chosen : (modelDefaultTier(this.registry.models.getModel(provider, model)) ?? null);
	}

	/** A subagent on the session's own model runs at the session's speed, on another model at that model's own default. */
	private subagentTier(rec: SessionRecord, provider: string, modelId: string): ServiceTier | null {
		if (provider === rec.provider && modelId === rec.model) return this.store.get(rec.id)?.serviceTier ?? null;
		return modelDefaultTier(this.registry.models.getModel(provider, modelId)) ?? null;
	}

	/** An image model only draws (through the generate_image tool); a chat never runs on it. */
	private assertChatModel(provider: string, model: string): void {
		if (this.registry.isImageModel?.(provider, model)) throw new HttpError(409, "image_model_not_chat", IMAGE_MODEL_IN_CHAT);
	}

	isRunning(id: string): boolean {
		return this.live.get(id)?.running ?? false;
	}

	/** True when the session has no messages, no saved context, no goal or scheduled tasks, and no active/pending run. */
	isEmpty(id: string): boolean {
		this.get(id);
		if (this.store.nextSeq(id) > 0 || this.store.context(id)) return false;
		if (this.goals?.list(id).length) return false;
		if (this.scheduler?.list(id).length) return false;
		const live = this.live.get(id);
		if (live && (live.running || live.pendingPrompt || live.compacting || live.deferred?.length)) return false;
		return true;
	}

	delete(id: string): void {
		this.get(id);
		const live = this.live.get(id);
		if (live) {
			live.compacting?.abort();
			live.retryWait?.abort();
			if (live.running) {
				live.stopCause ??= "close";
				live.forceStopped = true;
				live.running = false;
				live.agent.abort();
				live.cutLoose?.();
			}
		}
		this.describer.abort(id);
		this.dispose(id);
		this.clearSessionMemory(id, true);
		const spillDir = this.spillDir(id);
		if (spillDir) {
			try { rmSync(spillDir, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
		}
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
				serviceTier: src.serviceTier ?? null,
				systemPrompt: src.systemPrompt,
				tools: src.tools,
			},
			src.id,
		);
		const copied = this.store.copyMessages(id, copy.id, atSeq);
		if (src.activeDir) this.store.setActiveDir(copy.id, src.activeDir); // the copy goes on in the worktree its history moved to
		this.bus.publish(copy.id, "session_forked", { from: id, atSeq: atSeq ?? null, messages: copied });
		this.ext?.notify("session_fork", { sessionId: copy.id, from: id }, copy.id);
		return this.get(copy.id);
	}

	// ── Running ─────────────────────────────────────────────────────────────

	async send(
		id: string,
		input: {
			text: string;
			images?: ImageContent[];
			files?: { name: string; data: string }[];
			mode?: PromptMode;
			origin?: RunOrigin;
			command?: { name: "compact"; instructions?: string };
			clientRequestId?: string;
		},
	): Promise<{ accepted: "prompt" | "steer" | "follow_up" }> {
		const record = this.get(id);
		const key = input.clientRequestId ? `${id}\0${input.clientRequestId}` : null;
		if (key) {
			this.pruneRecentSends();
			const cached = this.recentSends.get(key);
			if (cached) return { accepted: cached.accepted };
			const inflight = this.inflightSends.get(key);
			if (inflight) return inflight;
		}
		const task = this.sendInner(id, record, input);
		if (!key) return task;
		const tracked = task.then((res) => {
			this.recentSends.set(key, { accepted: res.accepted, at: Date.now() });
			this.pruneRecentSends();
			return res;
		});
		this.inflightSends.set(key, tracked);
		tracked.finally(() => {
			if (this.inflightSends.get(key) === tracked) this.inflightSends.delete(key);
		}).catch(() => {});
		return tracked;
	}

	private pruneRecentSends(now = Date.now()): void {
		const ttl = 5 * 60_000;
		const max = 1000;
		for (const [k, v] of this.recentSends) {
			if (now - v.at > ttl) this.recentSends.delete(k);
		}
		while (this.recentSends.size > max) {
			const oldest = this.recentSends.keys().next().value;
			if (oldest === undefined) break;
			this.recentSends.delete(oldest);
		}
	}

	private async sendInner(
		id: string,
		record: SessionRecord,
		input: { text: string; images?: ImageContent[]; files?: { name: string; data: string }[]; mode?: PromptMode; origin?: RunOrigin; command?: { name: "compact"; instructions?: string } },
	): Promise<{ accepted: "prompt" | "steer" | "follow_up" }> {
		if (record.closed) throw conflict("session is closed; resume it first (PATCH closed=false)");
		this.assertChatModel(record.provider, record.model);
		const mode = input.mode ?? "prompt";
		if (input.command) {
			// A command is never a prompt: the server holds it and runs it when the run ends, in order with the other follow-ups.
			if (mode !== "follow_up") throw badRequest('a command can only be queued with mode "follow_up"');
			this.assertJoinable(id, mode);
			const live = this.live.get(id)!;
			const instructions = input.command.instructions?.trim() || undefined;
			(live.deferred ??= []).push({ kind: "compact", text: input.text, ...(instructions ? { instructions } : {}) });
			this.bus.publish(id, "message_queued", { mode, text: input.text, deferred: true });
			return { accepted: mode };
		}
		const rawText = input.text;
		const pre = await this.preprocess(id, input.text, mode, workDirOf(record));
		if (pre.handled) return { accepted: mode };
		input = { ...input, text: pre.text };
		const extraParts = pre.parts;
		const inputTitle = pre.title;
		// A prompt sent during a manual compaction waits for it to finish instead of being rejected.
		const compacting = this.live.get(id);
		if (mode === "prompt" && compacting?.compacting && !compacting.running) {
			const job = compacting.compacting;
			await compacting.compactSettled;
			// Stopping the compaction stops what waited for it too: the sender keeps the text instead of it going out later.
			if (job.signal.aborted) throw conflict("the compaction it waited for was stopped; send it again", { reason: "stopped" });
		}
		if (mode !== "prompt") this.assertJoinable(id, mode);
		if (mode === "prompt" && this.live.get(id)?.running) throw conflict('session is busy; send with mode "steer" or "follow_up"');
		await this.refreshChatModels();
		const live = this.ensureLive(record);

		const content: ({ type: "text"; text: string } | ImageContent)[] = [{ type: "text", text: input.text }, ...extraParts];
		const moved = this.workdirOps.takeNote(id);
		if (moved) content.push({ type: "text", text: `${HINT_OPEN}${moved}</pipaya-hint>` });
		for (const hint of this.peers.hints(id, input.text)) content.push({ type: "text", text: hint });
		if (input.origin === "schedule") content.push({ type: "text", text: SCHEDULE_NOTE });
		if (input.origin === "goal") {
			if (mode !== "steer") content.push({ type: "text", text: GOAL_NOTE });
		} else {
			this.goals?.cancelPending(id);
		}
		if (this.skills) {
			const callable = this.skills.callable(record.cwd, id);
			for (const name of mentionedSkills(input.text, callable.map((s) => s.name))) {
				const skill = callable.find((s) => s.name === name)!;
				const body = readSkillText(skill.path);
				if (body !== null) content.push({ type: "text", text: skillCallHint(skill, body, "<pipaya-hint>") });
			}
		}
		if (input.images?.length) {
			content.push(...input.images);
			const saved = await saveInlineImages(workDirOf(record), input.images);
			if (saved.length) content.push({ type: "text", text: inlineImagesHint(saved) });
		}
		if (input.files?.length) {
			const saved = await saveUploads(workDirOf(record), input.files);
			content.push({ type: "text", text: filesNote(saved) });
		}
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		const origin: RunOrigin = input.origin ?? "user";

		if (mode === "steer" || mode === "follow_up") {
			this.assertJoinable(id, mode); // again: the uploads above took a while, the run may have ended or been stopped
			// A person joining a run that another session started makes it a run for the person; a peer never takes it back.
			if (origin === "user") live.origin = "user";
			sentText.set(message, input.text);
			if (mode === "steer") live.agent.steer(message);
			else if (live.deferred?.length) live.deferred.push({ kind: "message", text: input.text, message, origin });
			else live.agent.followUp(message);
			this.bus.publish(id, "message_queued", { mode, text: input.text, ...(mode === "follow_up" && live.deferred?.length ? { deferred: true } : {}) });
			return { accepted: mode };
		}

		if (live.running) throw conflict('session is busy; send with mode "steer" or "follow_up"');
		const first = this.store.nextSeq(id) === 0;
		const shortTitle = autoTitle(inputTitle ?? input.text);
		if (record.title === "New session" && first && origin !== "goal") this.update(id, { title: shortTitle }, { automatic: true });
		if (origin !== "goal") this.describer.describe(id, first ? input.text : undefined, input.text, shortTitle, origin);
		this.run(id, live, "prompt", origin, async () => {
			await this.autoCompact(id);
			if (live.stopCause === "user" && live.recallCandidate) return;
			live.runSystem = undefined;
			if (this.ext?.has("before_agent_start")) {
				await this.ext.emit("before_agent_start", { sessionId: id, text: input.text }, id, (r) => {
					if (r.systemPrompt !== undefined) live.runSystem = { ...live.runSystem, replace: r.systemPrompt };
					if (r.appendSystemPrompt) live.runSystem = { ...live.runSystem, append: `${live.runSystem?.append ?? ""}\n\n${r.appendSystemPrompt}` };
					if (r.message) (message.content as { type: string; text?: string }[]).push({ type: "text", text: r.message });
				});
				if (live.stopCause === "user" && live.recallCandidate) return;
			}
			await live.agent.prompt(message);
		}, message, undefined, origin === "user" ? { message, text: rawText, userSeq: null } : undefined);
		return { accepted: "prompt" };
	}

	/** Gives a role to the active sessions that have talked but have none yet (after a system model is set, and at start). */
	describeAll(): void {
		this.describer.describeAll();
	}

	/** `input` hooks, built-in `/prompt:` templates and `/command` handling. A swallowed message is never sent to the model. */
	private async preprocess(id: string, text: string, mode: PromptMode, cwd: string): Promise<{ handled: boolean; text: string; parts: { type: "text"; text: string }[]; title?: string }> {
		let current = text;
		let handled = false;
		const parts: { type: "text"; text: string }[] = [];
		let title: string | undefined;
		let note: MessageNote | undefined;
		const typed = text.trim();
		if (this.ext) {
			await this.ext.emit("input", { sessionId: id, text: current, mode }, id, (r) => {
				if (typeof r.text === "string") current = r.text;
				if (Array.isArray(r.parts)) for (const p of r.parts) if (p?.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
				if (typeof r.title === "string" && r.title.trim()) title = r.title;
				if (r.note && typeof r.note.text === "string") note = r.note;
				if (r.handled) { handled = true; return true; }
			});
		}
		const withNote = () => (note ? [...parts, { type: "text" as const, text: noteBlock(note, typed) }] : parts);
		if (handled) return { handled, text: current, parts, title };
		const tpl = runPromptTemplate(current, cwd, this.home);
		if (tpl) return { handled: false, text: tpl.prompt, parts: [...parts, { type: "text" as const, text: noteBlock(tpl.note, typed) }], title: title ?? tpl.title };
		const cmd = this.ext ? await this.ext.runCommand(id, current) : undefined;
		if (cmd?.note) note = cmd.note;
		if (cmd?.title) title = cmd.title;
		if (cmd) return cmd.prompt ? { handled: false, text: cmd.prompt, parts: withNote(), title } : { handled: true, text: current, parts, title };
		return { handled: false, text: current, parts: withNote(), title };
	}

	/**
	 * A steer / follow_up needs a run that is going and not being stopped (a stopped run takes nothing more). The 409
	 * says `reason: "stopped"` when the run was stopped, so a client keeps the text instead of starting a new run with it.
	 */
	private assertJoinable(id: string, mode: "steer" | "follow_up"): void {
		const live = this.live.get(id);
		if (live?.running && !live.stopCause) return;
		if (live?.running || this.stopped.has(id)) throw conflict(`the run was stopped; send again with mode "prompt" to start a new one`, { reason: "stopped" });
		throw conflict(`session is idle; use mode "prompt" (mode "${mode}" needs an active run)`);
	}

	/** Removes one not-yet-delivered steer/follow_up message (the first one in that queue with this text). */
	cancelQueued(id: string, mode: "steer" | "follow_up", text: string, deferred?: boolean): boolean {
		this.get(id);
		const live = this.live.get(id);
		if (!live) return false;
		const held = (): boolean => {
			const j = live.deferred?.findIndex((d) => d.text === text) ?? -1;
			if (j < 0) return false;
			live.deferred!.splice(j, 1);
			this.bus.publish(id, "message_dequeued", { mode: "follow_up", text, deferred: true });
			return true;
		};
		if (deferred) return mode === "follow_up" && held();
		const items = agentQueue(live, mode);
		if (!items) return deferred === undefined && mode === "follow_up" && held();
		const i = items.findIndex((m) => queuedText(m) === text);
		if (i < 0) return deferred === undefined && mode === "follow_up" && held();
		items.splice(i, 1);
		this.bus.publish(id, "message_dequeued", { mode, text });
		return true;
	}

	/** Retry after an error/abort: drops the failed assistant message and re-requests. */
	retry(id: string): void {
		const record = this.get(id);
		if (record.closed) throw conflict("session is closed; resume it first (PATCH closed=false)");
		if (this.live.get(id)?.running) throw conflict("session is busy");
		const history = this.store.lastMessages(id, 4).map((m) => m.message);
		const lastStored = history.at(-1);
		const stripLast = lastStored?.role === "assistant" && (lastStored.stopReason === "error" || lastStored.stopReason === "aborted");
		const stripped = stripLast ? history.slice(0, -1) : history;
		const retryTail = stripped.at(-1);
		if (unresolvedToolCalls(stripped).length === 0 && (!retryTail || retryTail.role === "assistant" || retryTail.role === "system")) {
			throw conflict("nothing to retry");
		}
		const live = this.ensureLive(record);

		const messages = live.agent.state.messages;
		const last = messages[messages.length - 1];
		const dropLive = last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
		const liveStripped = dropLive ? messages.slice(0, -1) : messages;
		const liveTail = liveStripped[liveStripped.length - 1];
		if (unresolvedToolCalls(liveStripped).length === 0 && (!liveTail || liveTail.role === "assistant" || liveTail.role === "system")) {
			throw conflict("nothing to retry");
		}

		let droppedSeq: number | undefined;
		if (dropLive) {
			this.store.deleteLastMessage(id);
			live.nextSeq--;
			droppedSeq = live.nextSeq;
			live.agent.state.messages = liveStripped;
		}
		this.run(
			id,
			live,
			"retry",
			"user",
			() => {
				// Emit synthetic tool results AFTER run_started (with droppedSeq) so clients roll back lastSeq first.
				for (const call of unresolvedToolCalls(live.agent.state.messages)) {
					const msg = interruptedToolResult(call, "Run interrupted before tool completed");
					const seq = live.nextSeq++;
					this.store.appendMessage(id, seq, msg);
					live.agent.state.messages = [...live.agent.state.messages, msg];
					this.bus.publish(id, "message_end", { seq, message: msg });
					this.ext?.notify("message_end", { sessionId: id, message: msg, seq }, id);
				}
				return live.agent.continue();
			},
			undefined,
			droppedSeq,
		);
	}

	abort(id: string): boolean {
		this.get(id);
		const live = this.live.get(id);
		if (!live) return false;
		let did = false;
		if (live.compacting) { live.compacting.abort(); did = true; }
		if (live.running) { this.abortRun(id, live, "user"); did = true; }
		// Also stops a queued /compact that already runs after its run: the messages held behind it must not go out.
		if (did) this.dropQueued(id, live);
		return did;
	}

	/**
	 * Cooperative abort, then a hard stop: if the run is still going after FORCE_STOP_MS (a provider stream or tool that
	 * ignores the signal), drop the stuck agent, publish run_finished ourselves and let the next message start fresh
	 * from the stored transcript. Without this, Esc could leave a session "running" forever.
	 */
	private abortRun(id: string, live: Live, cause: RunStopCause, timeoutMs = FORCE_STOP_MS): void {
		const settled = live.settled;
		live.stopCause ??= cause;
		this.stopped.add(id);
		live.agent.abort();
		this.dropQueued(id, live);
		// Waiting out a retry is idle work; stopping it there must not wait for the backoff to end.
		live.retryWait?.abort();
		const timer = setTimeout(() => {
			if (!live.running || live.settled !== settled || this.live.get(id) !== live) return;
			const effectiveCause = live.stopCause ?? cause;
			live.forceStopped = true;
			live.running = false;
			live.lastActive = Date.now();
			this.dropQueued(id, live);
			this.dispose(id);
			live.cutLoose?.();
			if (effectiveCause === "shutdown") {
				const rec = this.store.get(id);
				if (rec) this.finalizeErrorTurn(id, rec, live, SHUTDOWN_RUN_ERROR, SHUTDOWN_TOOL_ERROR);
				this.store.clearActiveRun(id);
				const origin = this.peers.settleRun(id, live.origin, "error");
				this.bus.publish(id, "run_finished", {
					status: "error",
					error: SHUTDOWN_RUN_ERROR,
					durationMs: Date.now() - live.runStartedAt,
					origin,
					usage: this.store.usage(id),
					cause: "shutdown",
				});
				return;
			}
			this.store.clearActiveRun(id);
			this.goals?.onRunFinished(id, { status: "aborted", error: FORCE_STOP_ERROR, cause: "force", origin: live.origin });
			this.bus.publish(id, "run_finished", {
				status: "aborted",
				error: FORCE_STOP_ERROR,
				durationMs: Date.now() - live.runStartedAt,
				origin: live.origin,
				usage: this.store.usage(id),
				cause: "force",
			});
		}, timeoutMs);
		timer.unref?.();
		void settled?.finally(() => clearTimeout(timer));
	}

	shutdown(): void {
		clearInterval(this.sweeper);
		this.closing = true;
		this.describer.abortAll();
		for (const id of this.live.keys()) this.ext?.notify("session_shutdown", { sessionId: id }, id);
		for (const [id, live] of [...this.live]) {
			live.compacting?.abort();
			if (live.running) this.abortRun(id, live, "shutdown", this.shutdownStopMs);
			else this.dispose(id);
		}
	}

	/**
	 * On server start, finalizes any runs that were left active by a crash, SIGKILL or sudden reboot: restores an
	 * unpersisted prompt, closes orphaned tool calls with error toolResults, appends an error assistant message and
	 * publishes `run_finished(status: "error", cause: "restart")` so sessions never silently become idle.
	 */
	recoverInterruptedRuns(): number {
		const active = this.store.activeRuns();
		if (!active.length) return 0;
		const finished: { sessionId: string; origin: RunOrigin; durationMs: number }[] = [];
		// First close every interrupted transcript and clear active_runs, before publishing `run_finished` (which may notify
		// watcher sessions that were themselves interrupted in the same crash).
		for (const run of active) {
			const rec = this.store.get(run.sessionId);
			if (!rec) {
				this.store.clearActiveRun(run.sessionId);
				continue;
			}
			this.finalizeErrorTurn(run.sessionId, rec, undefined, RESTART_RUN_ERROR, RESTART_TOOL_ERROR, run.pendingPrompt ?? undefined);
			this.store.clearActiveRun(run.sessionId);
			finished.push({ sessionId: run.sessionId, origin: run.origin, durationMs: Math.max(0, Date.now() - run.startedAt) });
		}
		for (const item of finished) {
			const origin = this.peers.settleRun(item.sessionId, item.origin, "error");
			this.bus.publish(item.sessionId, "run_finished", {
				status: "error",
				error: RESTART_RUN_ERROR,
				durationMs: item.durationMs,
				origin,
				usage: this.store.usage(item.sessionId),
				cause: "restart",
			});
		}
		return finished.length;
	}

	/**
	 * The `delegate` calls of the active sessions, for the graph view. Each says whether its role has a file (a free role
	 * has none) and the model it ran on; for a call still running (no result yet) that is the model it would get by the same
	 * rule as `delegate`: the `model` argument when the policy takes one, else the role file's, else the session's own.
	 */
	delegateRuns(): DelegateRun[] {
		const pol = this.delegatePolicy();
		const disabled = this.disabledSubagents();
		const roles = new Map<string, Map<string, SubagentDef>>(); // per cwd, read once per request
		return this.store.delegateCalls().map(({ cwd, provider, sessionModel, ...c }) => {
			let defs = roles.get(cwd);
			if (!defs) roles.set(cwd, (defs = loadSubagents(cwd, this.home, disabled)));
			const def = defs.get(c.role);
			const running = c.doneAt === null && (this.live.get(c.sessionId)?.agent.state.pendingToolCalls.has(c.callId) ?? false);
			let model = c.model;
			if (!model) {
				const asked = c.asked && pol.policy !== "defined" ? c.asked : undefined;
				const spec = asked ?? def?.model;
				model = !spec ? `${provider}/${sessionModel}` : spec.includes("/") ? spec : `${provider}/${spec}`;
			}
			return { ...c, free: !def, running, model };
		});
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
		for (const [sessionId, l] of this.live) if (l.running || l.compacting) row(sessionId).running = true;
		for (const r of this.questions?.list() ?? []) row(r.sessionId).pendingQuestions++;
		return [...out.values()];
	}

	get runningCount(): number {
		return [...this.live.values()].filter((l) => l.running).length;
	}

	/** Wait until every active run has settled (used on shutdown and in tests). */
	async idle(): Promise<void> {
		while (this.pendingRuns.size > 0 || this.describer.hasPending()) {
			await Promise.all([...this.pendingRuns, ...this.describer.pendingJobs()]);
		}
		await Promise.all([...this.live.values()].map((l) => l.agent.waitForIdle()));
	}

	// ── Internals ───────────────────────────────────────────────────────────

	/**
	 * `origin` says who this run is for (see RunOrigin): "peer" when another session's message (or a server report to a
	 * watcher) started it, "user" otherwise. It is stamped on run_started and run_finished so notifications can be decided
	 * from the event alone.
	 */
	private run(id: string, live: Live, mode: string, origin: RunOrigin, start: () => Promise<void>, pendingPrompt?: AgentMessage, droppedSeq?: number, recallCandidate?: RecallCandidate): void {
		this.peers.resetRun(id);
		this.delegates.resetRun(id);
		live.running = true;
		this.stopped.delete(id);
		live.origin = origin;
		live.runStartedAt = Date.now();
		live.turns = 0;
		live.hinted = undefined;
		live.recentCalls = [];
		live.cycleWindow = [];
		live.recentErrors = [];
		const initialGoalNote = this.goals?.systemNote(id);
		live.runGoalNote = initialGoalNote ? { note: initialGoalNote, userTimestamp: pendingPrompt?.timestamp } : undefined;
		live.stopCause = undefined;
		live.limitReason = undefined;
		live.forceStopped = false;
		live.pendingPrompt = pendingPrompt;
		live.recallCandidate = recallCandidate;
		let releaseCutLoose = () => {};
		const cutLoosePromise = new Promise<void>((r) => { releaseCutLoose = r; });
		live.cutLoose = releaseCutLoose;
		this.store.markRunActive(id, { origin, startedAt: live.runStartedAt, ...(pendingPrompt ? { pendingPrompt } : {}) });
		this.bus.publish(id, "run_started", droppedSeq !== undefined ? { mode, origin, droppedSeq } : { mode, origin });
		this.goals?.onRunStarted(id);

		const settled = (async () => {
			let error: string | null = null;
			let interrupted = false;
			try {
				try {
					await start();
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
				// The provider rejected the request because the context is too big: compact once and carry on.
				if (!error && !live.forceStopped && !live.stopCause && (await this.recoverFromOverflow(id, live))) {
					try {
						await live.agent.continue();
					} catch (e) {
						error = e instanceof Error ? e.message : String(e);
					}
				}
				// The gateway closed the socket after part of the reply had streamed: a half-written answer cannot be resumed,
				// so drop it and ask again with backoff instead of ending the run on a transport hiccup.
				if (!error && !live.forceStopped && live.stopCause !== "shutdown") {
					const retried = await retryDroppedMidStream({
						getLastMessage: () => live.agent.state.messages[live.agent.state.messages.length - 1],
						shouldStop: () => live.forceStopped || live.stopCause === "shutdown",
						sleep: async (delayMs) => {
							const wait = new AbortController();
							live.retryWait = wait;
							await sleepAbortable(delayMs, wait.signal);
							live.retryWait = undefined;
							return { aborted: wait.signal.aborted, forceStopped: live.forceStopped };
						},
						dropLastReply: () => this.dropLastReply(id, live),
						continueRun: () => live.agent.continue(),
						onRetry: (notice) => this.bus.publish(id, "run_retrying", notice, { ephemeral: true }),
						catchErrors: true,
					});
					if (retried.forceStopped) return; // run_finished was already published when it was cut loose
					if (retried.aborted && (live.stopCause as RunStopCause | undefined) !== "shutdown") interrupted = true;
					if (retried.error !== null) error = retried.error;
				}
				// When the primary model stalls repeatedly with zero output, switch to the configured fallback model for this run.
				if (!error && !interrupted && !live.forceStopped && !live.stopCause) {
					const fb = await this.recoverWithFallbackModel(id, live);
					if (live.forceStopped) return;
					if (fb.interrupted) interrupted = true;
					if (fb.error !== undefined && fb.error !== null) error = fb.error;
				}
				// Repeated zero-output failures on a large transcript (e.g. 300k+ tokens where Gemini/CLIProxyAPI stalls
				// deterministically even after pre-commit / mid-stream retries): compact once and continue.
				// Even if fallback also failed with a zero-output error, still attempt zero-output compaction recovery.
				const fallbackZeroOutput = error !== null && isZeroOutputError(error);
				if ((!error || fallbackZeroOutput) && !interrupted && !live.forceStopped && !live.stopCause && (await this.recoverFromZeroOutput(id, live))) {
					error = null;
					try {
						await live.agent.continue();
					} catch (e) {
						error = e instanceof Error ? e.message : String(e);
					}
				}
				if (live.forceStopped) return; // run_finished was already published when it was cut loose
				live.running = false;
				live.runGoalNote = undefined;
				live.lastActive = Date.now();
				const record = this.store.get(id);
				if (!record) return;
				// Stopped by the run limit: the model call that was already under way was cut off and left an empty error reply.
				// That is our doing, not a failure: remove it so it neither reaches the model nor shows as "aborted".
				const shutdownStop = live.stopCause === "shutdown";
				const limited = live.stopCause === "limit";
				if (limited && isEmptyFailedReply(live.agent.state.messages[live.agent.state.messages.length - 1])) this.dropLastReply(id, live);

				let intentionalAbort = false;
				if (shutdownStop) {
					error = SHUTDOWN_RUN_ERROR;
					this.finalizeErrorTurn(id, record, live, SHUTDOWN_RUN_ERROR, SHUTDOWN_TOOL_ERROR);
				} else {
					const lastBefore = live.agent.state.messages[live.agent.state.messages.length - 1];
					const failedBefore = lastBefore?.role === "assistant" && (lastBefore.stopReason === "error" || lastBefore.stopReason === "aborted");
					error ??= failedBefore ? (lastBefore.errorMessage ?? null) : null;
					if (limited) error = live.limitReason ?? error;
					intentionalAbort = limited || interrupted || live.stopCause === "user" || live.stopCause === "close" || (!error && lastBefore?.role === "assistant" && lastBefore.stopReason === "aborted");
					if (!intentionalAbort && (error || (lastBefore?.role === "assistant" && lastBefore.stopReason === "error"))) {
						const reason = error || "The run stopped with an unknown error.";
						error = reason;
						this.finalizeErrorTurn(id, record, live, reason, reason);
					}
				}

				const recalledPrompt = this.recallAbortedPrompt(id, live, shutdownStop, limited);
				const last = live.agent.state.messages[live.agent.state.messages.length - 1];
				const failed = last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
				const status: "ok" | "error" | "aborted" = shutdownStop ? "error" : intentionalAbort ? "aborted" : !failed && !error ? "ok" : "error";
				// Sent while the stop took effect (the run still counted as busy, so they were queued): dropped like the rest.
				if (status === "aborted" || shutdownStop) this.dropQueued(id, live);
				this.store.clearActiveRun(id);
				// The last hop of an agent-to-agent chain the person started (A → B → A, A answers) ends as "user": it notifies.
				const settledOrigin = this.peers.settleRun(id, live.origin, status);
				// Update goal state before publishing run_finished so notifications and unread marks see the final status.
				this.goals?.onRunFinished(id, { status, error, cause: live.stopCause, origin: settledOrigin });
				this.bus.publish(id, "run_finished", {
					status,
					error,
					durationMs: Date.now() - live.runStartedAt,
					origin: settledOrigin,
					usage: this.store.usage(id),
					...(live.stopCause ? { cause: live.stopCause } : {}),
					...(recalledPrompt ? { recalledPrompt } : {}),
				});
				if (this.closing) {
					this.dispose(id);
					return;
				}
				// Commands and messages queued behind them go on now (not after a stop: dropQueued emptied them above).
				const next = this.drainDeferred(id, live, status);
				this.pendingRuns.add(next);
				void next.finally(() => this.pendingRuns.delete(next));
			} catch (unexpected) {
				if (live.forceStopped) return;
				live.running = false;
				live.lastActive = Date.now();
				const reason = (unexpected instanceof Error ? unexpected.message : String(unexpected)) || "The run stopped unexpectedly.";
				const rec = this.store.get(id);
				if (rec) {
					try { this.finalizeErrorTurn(id, rec, live, reason, reason); } catch { /* still clear active_runs and publish run_finished */ }
					try { this.store.clearActiveRun(id); } catch { /* ignore */ }
					this.goals?.onRunFinished(id, { status: "error", error: reason, cause: live.stopCause, origin: live.origin });
					this.bus.publish(id, "run_finished", {
						status: "error",
						error: reason,
						durationMs: Date.now() - live.runStartedAt,
						origin: live.origin,
						usage: this.store.usage(id),
						...(live.stopCause ? { cause: live.stopCause } : {}),
					});
				}
				if (this.closing) this.dispose(id);
			} finally {
				live.recallCandidate = undefined;
				releaseCutLoose();
			}
		})();
		live.settled = settled;
		const tracked = Promise.race([settled, cutLoosePromise]);
		this.pendingRuns.add(tracked);
		void tracked.finally(() => this.pendingRuns.delete(tracked));
	}

	/**
	 * Ensures the stored transcript of an interrupted/failed run ends in a clean, retryable error state:
	 * 1) persists an initial user prompt if the run died before `agent.prompt()` emitted `message_end`,
	 * 2) closes any unresolved `toolCall` blocks with error `toolResult` messages, and
	 * 3) appends or upgrades the trailing assistant message to `stopReason: "error"` with `reason`.
	 */
	private finalizeErrorTurn(id: string, record: SessionRecord, live: Live | undefined, reason: string, toolReason: string, pendingPrompt?: AgentMessage): void {
		let nextSeq = live ? live.nextSeq : this.store.nextSeq(id);
		const modelObj = live?.agent.state.model ?? this.registry.models.getModel(record.provider, record.model);
		const meta = { provider: record.provider, model: record.model, api: modelObj?.api };
		const append = (msg: AgentMessage) => {
			const seq = nextSeq++;
			this.store.appendMessage(id, seq, msg);
			if (live) live.agent.state.messages = [...live.agent.state.messages, msg];
			this.bus.publish(id, "message_end", { seq, message: msg });
			this.ext?.notify("message_end", { sessionId: id, message: msg, seq }, id);
		};

		const prompt = pendingPrompt ?? live?.pendingPrompt;
		if (prompt) {
			if (live) live.pendingPrompt = undefined;
			this.store.clearPendingPrompt(id);
			append(prompt);
		}

		const projected = this.store.projection(id).messages;
		for (const call of unresolvedToolCalls(projected.map((m) => m.message))) {
			append(interruptedToolResult(call, toolReason));
		}

		const lastStored = this.store.lastMessages(id, 1)[0];
		if (lastStored?.message.role === "assistant") {
			const m = lastStored.message;
			if (m.stopReason === "aborted" || (m.stopReason === "error" && !m.errorMessage?.trim())) {
				const fixed = { ...m, stopReason: "error" as const, errorMessage: reason } as AgentMessage;
				this.store.replaceMessage(id, lastStored.seq, fixed);
				if (live && live.agent.state.messages.length > 0) {
					live.agent.state.messages = [...live.agent.state.messages.slice(0, -1), fixed];
				}
			}
		} else {
			append(interruptedAssistantMessage(meta, reason));
		}

		if (live) live.nextSeq = nextSeq;
	}

	/**
	 * Works through the follow-ups the server holds (see Deferred), in the order they were typed: a `/compact` runs
	 * itself; the messages after it go out as one run, and the next command waits for that run to end.
	 */
	private async drainDeferred(id: string, live: Live, status: "ok" | "error" | "aborted"): Promise<void> {
		if (status === "aborted") return;
		while (live.deferred?.length && !live.running && !this.closing && this.live.get(id) === live) {
			const head = live.deferred[0]!;
			if (head.kind === "compact") {
				live.deferred.shift();
				this.bus.publish(id, "message_dequeued", { mode: "follow_up", text: head.text, deferred: true });
				try {
					await this.compact(id, head.instructions);
				} catch (e) {
					// compact() reports its own failures; a refusal before it started ("not enough history") has not been reported yet.
					if (!reported.has(e as object)) this.bus.publish(id, "compaction_failed", { aborted: false, errorMessage: e instanceof Error ? e.message : String(e) });
				}
				continue;
			}
			const batch: Extract<Deferred, { kind: "message" }>[] = [];
			while (live.deferred[0]?.kind === "message") batch.push(live.deferred.shift() as Extract<Deferred, { kind: "message" }>);
			const [first, ...rest] = batch as [Extract<Deferred, { kind: "message" }>, ...Extract<Deferred, { kind: "message" }>[]];
			this.run(id, live, "prompt", first.origin, async () => {
				for (const r of rest) live.agent.followUp(r.message);
				await this.autoCompact(id);
				if (live.stopCause === "user" && live.recallCandidate) return;
				await live.agent.prompt(first.message);
			}, first.message, undefined, first.origin === "user" ? { message: first.message, text: first.text, userSeq: null } : undefined);
			return;
		}
	}

	/**
	 * After a run that ended with a context-overflow error from the provider (the automatic threshold check missed it,
	 * e.g. an estimate that was too low): compact, drop the failed reply and report true so the caller continues.
	 * Only with automatic compaction on, and never twice in a row (a failed compaction leaves the error as it was).
	 */
	private async recoverFromOverflow(id: string, live: Live): Promise<boolean> {
		if (!this.compaction?.get().auto) return false;
		const messages = live.agent.state.messages;
		const last = messages[messages.length - 1];
		if (last?.role !== "assistant" || last.stopReason !== "error") return false;
		const window = live.agent.state.model?.contextWindow;
		if (!isContextOverflow(last, window)) return false;
		return this.compactAndDropFailedReply(id, live);
	}

	/**
	 * When the primary model repeatedly terminates with zero output, retries the failed turn on the configured fallback
	 * model for the remainder of this run without altering the session's saved primary model.
	 */
	private async recoverWithFallbackModel(id: string, live: Live): Promise<{ attempted: boolean; interrupted?: boolean; error?: string | null }> {
		if (!this.fallbackModel) return { attempted: false };
		const fallbackSettings = this.fallbackModel;
		const res = await recoverWithFallback({
			getLastMessage: () => live.agent.state.messages[live.agent.state.messages.length - 1],
			resolveFallback: async () => {
				const activeModel = live.agent.state.model;
				const currentRecord = this.store.get(id);
				const primary = { provider: activeModel?.provider ?? currentRecord?.provider ?? "", model: activeModel?.id ?? currentRecord?.model ?? "" };
				const fb = fallbackSettings.resolve(primary);
				if (!fb) return null;
				const fbModel = this.registry.models.getModel(fb.provider, fb.model);
				if (!fbModel || !(await this.registry.models.checkAuth(fb.provider))) return null;
				return { fb, fbModel, label: `${fb.provider}/${fb.model}` };
			},
			sleep: async (delayMs) => {
				const wait = new AbortController();
				live.retryWait = wait;
				await sleepAbortable(delayMs, wait.signal);
				live.retryWait = undefined;
				return { aborted: wait.signal.aborted, forceStopped: live.forceStopped };
			},
			dropLastReply: () => this.dropLastReply(id, live),
			runWithFallback: async ({ fb, fbModel }) => {
				const prevModel = live.agent.state.model;
				const prevThinking = live.agent.state.thinkingLevel;
				live.agent.state.model = fbModel;
				live.agent.state.thinkingLevel = fb.thinkingLevel ?? this.defaultThinkingLevel(fb.provider, fb.model);
				try {
					await live.agent.continue();
				} finally {
					const latest = this.store.get(id);
					live.agent.state.model = (latest && this.registry.models.getModel(latest.provider, latest.model)) ?? prevModel;
					live.agent.state.thinkingLevel = latest?.thinkingLevel ?? prevThinking;
				}
			},
			onRetry: (notice) => this.bus.publish(id, "run_retrying", notice, { ephemeral: true }),
			catchErrors: true,
		});
		if (res.forceStopped) return { attempted: false };
		if (res.aborted) return { attempted: true, interrupted: (live.stopCause as RunStopCause | undefined) !== "shutdown" };
		return { attempted: res.attempted, error: res.error };
	}

	/**
	 * After a run that exhausted upstream retries on a zero-output gateway error while carrying a large context
	 * (>= 32k tokens, or >= 25% of smaller model windows): compact once, drop the failed reply and let the run continue.
	 */
	private async recoverFromZeroOutput(id: string, live: Live): Promise<boolean> {
		if (!this.compaction?.get().auto) return false;
		const messages = live.agent.state.messages;
		const last = messages[messages.length - 1];
		if (last?.role !== "assistant" || last.stopReason !== "error" || !isZeroOutputError(last.errorMessage)) return false;
		const window = live.agent.state.model?.contextWindow;
		const minTokens = window && window > 0 ? Math.min(ZERO_OUTPUT_COMPACT_MIN_TOKENS, Math.floor(window * 0.25)) : ZERO_OUTPUT_COMPACT_MIN_TOKENS;
		const summaryAt = this.store.latestCompaction(id)?.createdAt;
		const sysLen = live.agent.state.systemPrompt.length;
		const estimated = messages.reduce((sum, m) => sum + estimateTokens(m), Math.ceil(sysLen / 4));
		const tokens = Math.max(contextTokens(messages, sysLen, summaryAt) ?? 0, estimated);
		if (tokens < minTokens) return false;
		return this.compactAndDropFailedReply(id, live);
	}

	private async compactAndDropFailedReply(id: string, live: Live): Promise<boolean> {
		try {
			await this.compact(id, undefined, "threshold");
		} catch { return false; } // compact() already published why
		const after = live.agent.state.messages;
		const tail = after[after.length - 1];
		if (tail?.role === "assistant" && tail.stopReason === "error") {
			this.store.deleteLastMessage(id);
			live.nextSeq--;
			live.agent.state.messages = after.slice(0, -1);
		}
		const next = live.agent.state.messages[live.agent.state.messages.length - 1];
		return !!next && next.role !== "assistant" && next.role !== "system";
	}

	/**
	 * When a direct user prompt is aborted by the user before the assistant has produced any visible text or
	 * started a tool call (nothing or thinking-only), roll the prompt (and any empty/thinking-only aborted reply)
	 * back from memory and SQLite so clients can return it to the composer.
	 */
	private recallAbortedPrompt(
		id: string,
		live: Live,
		shutdownStop: boolean,
		limited: boolean,
	): { text: string; fromSeq: number | null } | undefined {
		const candidate = live.recallCandidate;
		if (!candidate || live.stopCause !== "user" || shutdownStop || limited || live.forceStopped) return undefined;
		const messages = live.agent.state.messages;
		if (candidate.userSeq === null) {
			// Aborted before the prompt ever reached `message_end` (e.g. during `autoCompact` or `before_agent_start`).
			if (messages.lastIndexOf(candidate.message) >= 0) return undefined;
			live.pendingPrompt = undefined;
			return { text: candidate.text, fromSeq: null };
		}
		const idx = messages.lastIndexOf(candidate.message);
		if (idx < 0) return undefined;
		const tail = messages.slice(idx + 1);
		if (tail.length > 1) return undefined;
		if (live.nextSeq !== candidate.userSeq + 1 + tail.length) return undefined;
		if (tail.length === 1) {
			const reply = tail[0]!;
			if (reply.role !== "assistant") return undefined;
			const abortedOrEmptyErr = reply.stopReason === "aborted" || (reply.stopReason === "error" && isEmptyFailedReply(reply));
			if (!abortedOrEmptyErr || hasAssistantOutputOrTools(reply)) return undefined;
		}
		this.store.deleteMessagesFrom(id, candidate.userSeq);
		live.nextSeq = candidate.userSeq;
		live.agent.state.messages = messages.slice(0, idx);
		live.pendingPrompt = undefined;
		return { text: candidate.text, fromSeq: candidate.userSeq };
	}

	/** Throws the half-written reply away (`continue()` then replaces it, without asking the model to repeat itself). */
	private dropLastReply(id: string, live: Live): void {
		this.store.deleteLastMessage(id);
		live.nextSeq--;
		live.agent.state.messages = live.agent.state.messages.slice(0, -1);
	}

	private ensureLive(record: SessionRecord): Live {
		// a worktree removed since the last run sends the session home before its tools are built
		if (isGone(record.activeDir) && !this.live.get(record.id)?.running) { this.workdirOps.homeIfGone(record.id); record = this.store.get(record.id) ?? record; }
		const existing = this.live.get(record.id);
		if (existing) {
			// Refresh idle sessions after provider endpoint/model configuration changes.
			if (!existing.running) {
				const model = this.registry.models.getModel(record.provider, record.model);
				if (!model) throw badRequest(`unknown model ${record.provider}/${record.model}`);
				existing.agent.state.model = model;
				this.syncSkills(record.id, existing);
				const snap = this.store.context(record.id);
				if (snap) {
					existing.toolsDir = workDirOf(record);
					existing.toolsDirty = false;
					existing.agent.state.tools = this.sessionTools(record.id, snap.tools, existing.toolsDir, existing.readTracker);
				}
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
		const { instructions } = this.currentInstructions(snapshot);
		const readTracker = new Map<string, ReadTrackEntry>();
		const agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(snapshot.systemPrompt, instructions, skills, buildEnvContext(snapshot.cwd)),
				model,
				thinkingLevel: record.thinkingLevel,
				tools: this.sessionTools(record.id, snapshot.tools, workDirOf(record), readTracker),
				messages: history,
			},
			// A gateway that drops for a moment (502 …) is waited out instead of ending the run
			streamFn: withUpstreamRetry(async (m, ctx, opts) => {
				const current = this.get(record.id);
				const tier = current.provider === m.provider && current.model === m.id ? current.serviceTier ?? null : null;
				return streamAtTier(this.registry, m, ctx, opts, tier);
			}, {
				...DEFAULT_UPSTREAM_RETRY,
				onRetry: (attempt, maxRetries, delayMs, errorMessage) => this.bus.publish(record.id, "run_retrying", { attempt, maxRetries, delayMs, ...(retryReason(errorMessage) ? { reason: retryReason(errorMessage) } : {}) }, { ephemeral: true }),
			}),
			sessionId: record.id,
			transformContext: async (messages) => this.transformContext(record.id, messages),
			prepareNextTurnWithContext: async (turn) => {
				const out = await this.compactMidRun(record.id, turn.context.tools);
				const tools = this.retargetTools(record.id);
				return tools ? { ...out, context: { messages: out?.context.messages ?? turn.context.messages, tools } } : out;
			},
			beforeToolCall: async (c) => this.extensionToolCall(record.id, c),
			afterToolCall: async (c) => this.afterSessionTool(record.id, c),
		});

		const live: Live = {
			agent,
			nextSeq: this.store.nextSeq(record.id),
			running: false,
			runStartedAt: 0,
			origin: "user",
			lastActive: Date.now(),
			unsubscribe: () => {},
			promptKey: promptKey(skills, instructions),
			readTracker,
			pruneState: createContextPruneState(),
			cacheStats: { turns: 0, cacheRead: 0, cacheWrite: 0, input: 0, hitRate: 0 },
			toolsDir: workDirOf(record),
			turns: 0,
			recentCalls: [],
			cycleWindow: [],
			recentErrors: [],
		};
		live.unsubscribe = agent.subscribe((event) => this.onAgentEvent(record.id, live, event));
		this.live.set(record.id, live);
		return live;
	}

	/**
	 * Applies skill on/off and AGENTS.md changes to an idle session before its next run: rewrites the leading system
	 * message (which backs `agent.state.systemPrompt`). Nothing happens (and the provider's prompt cache is untouched)
	 * unless the enabled skills or the instruction files actually changed.
	 */
	private syncSkills(id: string, live: Live): void {
		const snapshot = this.store.context(id);
		if (!snapshot) return;
		const skills = this.currentSkills(id, snapshot);
		const { instructions } = this.currentInstructions(snapshot);
		const key = promptKey(skills, instructions);
		if (key === live.promptKey) return;
		const prompt = buildSystemPrompt(snapshot.systemPrompt, instructions, skills, buildEnvContext(snapshot.cwd));
		const [head, ...rest] = live.agent.state.messages;
		if (head?.role === "system") {
			live.agent.state.messages = [{ ...head, content: prompt } as AgentMessage, ...rest];
		} else {
			const sys = createInitialSystemMessage(prompt, live.agent.state.tools.map(toToolDeclaration));
			if (sys) live.agent.state.messages = [sys, ...live.agent.state.messages];
		}
		live.promptKey = key;
	}

	/** The tools a session's agent gets; tools the user switched off in the settings are left out. */
	private sessionTools(id: string, names: string[], cwd: string, readTracker?: Map<string, ReadTrackEntry>) {
		return buildTools(enabledTools(this.toolPlan(names)), cwd, [], this.toolContext(id, readTracker, cwd), this.toolDefs());
	}

	private toolPlan(names: string[]) {
		return planTools({ chosen: names, always: [...PEER_TOOLS, DELEGATE_TOOL, ...ALWAYS_TOOLS, ...(this.scheduler ? [SCHEDULE_TOOL] : []), ...(this.goals ? [GOAL_TOOL] : []), ...(this.mcp ? [MCP_TOOL] : []), ...(this.ext?.alwaysTools() ?? []), ...(this.mcp?.toolNames() ?? [])], disabled: this.disabledTools(), image: this.imageModel?.resolve() ? IMAGE_TOOL : undefined });
	}

	/** The text the system adds beyond the session prompt, tools and AGENTS.md, for the context view. */
	private systemPromptList(provider?: string, modelId?: string, anthropicOAuth?: boolean): SystemPromptEntry[] {
		const m = provider && modelId ? this.registry.models.getModel(provider, modelId) : undefined;
		const hooks = (["before_agent_start", "context", "input"] as const).filter((h) => this.ext?.has(h));
		return systemPromptEntries(m ? { provider: m.provider, api: m.api } : null, { hasExtensions: !!this.ext, extensionHooks: hooks, anthropicOAuth });
	}

	private toolSpecs(names: string[], cwd: string): ContextTool[] {
		return describeTools(this.toolPlan(names), this.toolDefs(), cwd, this.toolContext("preview", undefined, cwd));
	}

	private spillDir(sessionId: string): string | undefined {
		if (!this.cfg.dataDir || sessionId === "preview") return undefined;
		return join(this.cfg.dataDir, "tmp", "spill", sessionId);
	}

	/** Best-effort startup cleanup of `<dataDir>/tmp/spill/<id>` folders whose sessions no longer exist. */
	private async sweepOrphanSpills(): Promise<void> {
		if (!this.cfg.dataDir) return;
		const root = join(this.cfg.dataDir, "tmp", "spill");
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			return;
		}
		for (const id of entries) {
			if (!this.store.get(id)) {
				await rm(join(root, id), { recursive: true, force: true }).catch(() => {});
			}
		}
	}

	private availableModelsHint(): string {
		const list = modelList(this.chatModelIds);
		return list ? `; available: ${list}` : "";
	}

	/** What tools may ask of the running session. */
	private toolContext(sessionId: string, readTracker?: Map<string, ReadTrackEntry>, fallbackCwd?: string): ToolContext {
		const q = this.questions;
		const isPreview = sessionId === "preview";
		const ctx: ToolContext = {
			sessionId,
			...(!isPreview ? {
				getCwd: () => {
					const rec = this.store.get(sessionId);
					return rec ? workDirOf(rec) : (fallbackCwd ?? this.defaultWorkdir());
				},
				readTracker: readTracker ?? this.live.get(sessionId)?.readTracker,
				spillDir: this.spillDir(sessionId),
			} : {}),
			delegate: (_toolCallId, input, signal, progress) => this.delegate(sessionId, input, signal, progress),
			delegateRoles: () => this.delegatePolicy().roles,
			delegateModels: () => this.delegatePolicy(),
			chatModels: () => this.chatModelIds,
			peerEnabled: () => !this.disabledTools().includes("peer"),
			peers: {
				send: (to, message, opts) => this.peers.send(sessionId, to, message, opts),
				read: (from, count, detail) => this.peers.read(sessionId, from, count, detail),
				list: () => this.peers.list(sessionId),
				abort: (name) => this.peers.abort(sessionId, name),
				answer: (name, a) => this.peers.answer(sessionId, name, a),
				create: (input) => this.peers.create(sessionId, input),
				manage: (name, action, a) => this.peers.manage(sessionId, name, action, a),
				group: (action, a) => this.peers.group(sessionId, action, a),
			},
			schedules: this.scheduleOps(sessionId),
			goals: this.goalOps(sessionId),
			mcp: this.mcpOps(),
			workdir: {
				show: () => this.workdirOps.show(sessionId),
				move: (path) => this.moveWorkdir(sessionId, path, "agent").note,
			},
		};
		if (q) {
			ctx.ask = (toolCallId, req, signal) => askQuestion(q, sessionId, toolCallId, req, signal);
		}
		ctx.canSeeImages = () => {
			const liveModel = this.live.get(sessionId)?.agent.state.model;
			if (liveModel) return liveModel.input.includes("image");
			const rec = this.store.get(sessionId);
			const model = rec && this.registry.models.getModel(rec.provider, rec.model);
			return model ? model.input.includes("image") : true;
		};
		ctx.imageLimits = () => {
			const liveModel = this.live.get(sessionId)?.agent.state.model;
			if (liveModel) return liveModel.inputLimits?.images?.resize;
			const rec = this.store.get(sessionId);
			return rec ? this.registry.models.getModel(rec.provider, rec.model)?.inputLimits?.images?.resize : undefined;
		};
		return ctx;
	}


	/**
	 * How hard a subagent thinks: the call's `thinking` argument, else its role's level, else the calling session's own level when it runs on the same model,
	 * else that model's default (its connection setting, "auto" = the rules of a new chat). A model without reasoning ignores it.
	 */
	private subagentThinking(rec: SessionRecord, requested: ThinkingLevel | undefined, role: ThinkingLevel | undefined, provider: string, modelId: string): ThinkingLevel {
		if (requested) return requested;
		if (role) return role;
		if (provider === rec.provider && modelId === rec.model) return this.live.get(rec.id)?.agent.state.thinkingLevel ?? rec.thinkingLevel ?? this.defaultThinkingLevel(provider, modelId);
		return this.defaultThinkingLevel(provider, modelId);
	}

	/**
	 * `delegate`: a one-off subagent run. The subagent is a bare Agent that is never stored, so it is no session and shows in no list;
	 * only its final text goes back to the parent. Limits are enforced here and reported as conflicts, never dropped silently.
	 */
	private async delegate(sessionId: string, input: { role: string; task: string; model?: string; thinking?: ThinkingLevel }, signal: AbortSignal | undefined, progress: (line: string) => void) {
		const rec = this.store.get(sessionId);
		if (!rec) throw notFound("session");
		let requestedThinking: ThinkingLevel | undefined;
		if (input.thinking !== undefined) {
			if (!THINKING_LEVELS.includes(input.thinking)) throw badRequest(`thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
			requestedThinking = input.thinking;
		}
		const name = input.role.replace(/\.md$/, "");
		const defs = loadSubagents(rec.cwd, this.home, this.disabledSubagents());
		const pol = this.delegatePolicy();
		let def = defs.get(name);
		if (!def && pol.roles === "any") {
			// Free role: a name with no file is a general read-only subagent. A role file that exists but is switched off stays refused.
			if (!SUBAGENT_NAME.test(name)) throw badRequest(`subagent role "${input.role}": role names are letters, digits, '.', '_' and '-' (at most 40, starting with a letter or digit)`);
			if (loadSubagents(rec.cwd, this.home).has(name)) throw notFound(`subagent role "${input.role}" is switched off in the settings`);
			def = freeRole(name);
		}
		if (!def) throw notFound(`subagent role "${input.role}"; available: ${[...defs.keys()].join(", ") || "none (add files to ~/.agents/subagents or .agents/subagents, or switch a role on in the settings)"}`);
		const spec = chooseModel(pol, input.model, def.model);
		let provider = rec.provider, modelId = rec.model;
		if (spec) {
			const split = this.splitSpec(undefined, spec, rec.provider);
			if (split.provider && split.model) {
				provider = split.provider;
				modelId = split.model;
			} else if (this.registry.models.getModel(rec.provider, spec)) {
				provider = rec.provider;
				modelId = spec;
			} else {
				const i = spec.indexOf("/");
				[provider, modelId] = i > 0 ? [spec.slice(0, i), spec.slice(i + 1)] : [rec.provider, spec];
			}
		}
		const model = this.registry.models.getModel(provider, modelId);
		if (!model || this.registry.isImageModel?.(provider, modelId)) throw badRequest(`model ${provider}/${modelId} is not available for subagents${this.availableModelsHint()}`);
		const defs2 = this.toolDefs();
		const off = this.disabledTools();
		const names = def.tools.filter((n) => defs2[n] && !off.includes(n));
		const tools = buildTools(names, workDirOf(rec), [], {
			sessionId,
			canSeeImages: () => model.input.includes("image"),
			imageLimits: () => model.inputLimits?.images?.resize,
			spillDir: this.spillDir(sessionId),
		}, defs2);
		const cap = Math.min(def.maxTurns, pol.maxTurns);
		const tier = this.subagentTier(rec, provider, modelId);
		// The report uses the same run and context, and counts toward the existing ceiling.
		const oneCall = cap === 1 && tools.length > 0;
		const readOnly = new Set(names.filter((n) => (n === "read" || n === "grep" || n === "glob" || n === "ls") && defs2[n] === TOOL_DEFS[n]));
		let turns = 0, repeatCount = 0;
		let lastRead: string | undefined, limit: SubagentLimit | undefined;
		let startedAt = 0, stopping = false;
		const agent = new Agent({
			initialState: { systemPrompt: subagentSystem(def, workDirOf(rec)) + (oneCall ? `\n\n${SUBAGENT_WRAP_UP}` : ""), model, thinkingLevel: this.subagentThinking(rec, requestedThinking, def.thinking, provider, modelId), tools: oneCall ? [] : tools, messages: [] },
			streamFn: withUpstreamRetry((m, ctx, opts) => streamAtTier(this.registry, m, ctx, opts, m.provider === provider && m.id === modelId ? tier : this.subagentTier(rec, m.provider, m.id)), DEFAULT_UPSTREAM_RETRY),
			prepareRequest: (_request, requestSignal) => { requestSignal?.throwIfAborted(); turns++; },
			prepareNextTurnWithContext: (turn) => {
				if (repeatCount >= MAX_REPEATED_CALLS) limit = "repeatedTools";
				else if (turns >= cap - 1) limit = "maxTurns";
				else if (performance.now() - startedAt >= this.delegateTimeoutMs - subagentReportReserveMs(this.delegateTimeoutMs)) limit = "deadline";
				if (!limit || stopping) return;
				progress(`${def.name}: reporting partial results`);
				// The loop syncs tool declarations from this context before the provider request.
				return { context: { ...turn.context, tools: [] }, messages: [{ role: "system", content: SUBAGENT_WRAP_UP, timestamp: Date.now() }] };
			},
			finishTurn: (turn) => {
				if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
				if (limit || turns >= cap) {
					if (!limit && (turn.message.content.some((c) => c.type === "toolCall") || (oneCall && !finalText([turn.message]).text))) limit = "maxTurns";
					return { action: "end" };
				}
				const read = repeatedToolSignature(turn, readOnly);
				repeatCount = !read ? 0 : read === lastRead ? repeatCount + 1 : 1;
				lastRead = read;
			},
			beforeToolCall: async (c) => stopping ? { block: true, reason: "The subagent was stopped" } : this.extensionToolCall(sessionId, c),
			afterToolCall: async (c) => { if (!stopping) return this.extensionToolResult(sessionId, c); },
		});
		agent.subscribe((e) => {
			if (e.type === "tool_execution_start" && !stopping && !limit && !oneCall) progress(`${def.name}: ${e.toolName}`);
		});
		if (signal?.aborted) throw new Error("delegate aborted");
		const release = this.delegates.acquire(sessionId, { calls: pol.maxCalls, running: pol.maxConcurrent });
		const retryStop = new AbortController();
		const retrySignal = signal ? AbortSignal.any([signal, retryStop.signal]) : retryStop.signal;
		startedAt = performance.now();
		const outcome = await runDelegateWithinDeadline(
			async () => {
				// A detached tool still occupies a slot until it settles; retries must not pile up stuck work.
				try {
					await agent.prompt(input.task);
					// A stream cut off after thinking/partial text (e.g. post-thought MALFORMED_FUNCTION_CALL or reset)
					// bypasses withUpstreamRetry; drop the half-written reply and continue just like SessionManager.run.
					await retryDroppedMidStream({
						getLastMessage: () => agent.state.messages[agent.state.messages.length - 1],
						shouldStop: () => stopping || retrySignal.aborted,
						sleep: async (delayMs) => {
							await sleepAbortable(delayMs, retrySignal);
							return { aborted: stopping || retrySignal.aborted };
						},
						dropLastReply: () => {
							agent.state.messages = agent.state.messages.slice(0, -1);
							turns = Math.max(0, turns - 1);
						},
						continueRun: () => agent.continue(),
					});
					const fallbackSettings = this.fallbackModel;
					if (!stopping && !retrySignal.aborted && fallbackSettings) {
						await recoverWithFallback({
							getLastMessage: () => agent.state.messages[agent.state.messages.length - 1],
							resolveFallback: async () => {
								const active = agent.state.model;
								const fb = fallbackSettings.resolve({ provider: active.provider, model: active.id });
								const fbModel = fb && this.registry.models.getModel(fb.provider, fb.model);
								if (!fb || !fbModel || !(await this.registry.models.checkAuth(fb.provider))) return null;
								return { fb, fbModel, label: `${fb.provider}/${fb.model}` };
							},
							sleep: async (delayMs) => {
								await sleepAbortable(delayMs, retrySignal);
								return { aborted: stopping || retrySignal.aborted };
							},
							dropLastReply: () => {
								agent.state.messages = agent.state.messages.slice(0, -1);
								turns = Math.max(0, turns - 1);
							},
							runWithFallback: async ({ fb, fbModel }) => {
								agent.state.model = fbModel;
								agent.state.thinkingLevel = fb.thinkingLevel ?? this.subagentThinking(rec, requestedThinking, def.thinking, fb.provider, fb.model);
								await agent.continue();
							},
						});
					}
				} finally { release(); }
			},
			() => { stopping = true; retryStop.abort(); agent.abort(); }, signal, this.delegateTimeoutMs,
		);
		if (outcome === "cancelled" || signal?.aborted) throw new Error("delegate aborted");
		const timedOut = outcome === "deadline";
		if (timedOut) limit = "deadline";
		const messages = agent.state.messages;
		const { text: answer, error } = finalText(messages);
		if (error && !limit) throw new Error(`subagent ${def.name} failed: ${error}`);
		const rawText = limit ? subagentReport(messages, limit, { turns, maxRepeated: MAX_REPEATED_CALLS, timeoutMs: this.delegateTimeoutMs, timedOut }) : answer || "(the subagent returned no text)";
		const text = capSubagentOutput(rawText);
		const usedModel = agent.state.model;
		return { content: [{ type: "text" as const, text }], details: { role: def.name, model: `${usedModel.provider}/${usedModel.id}`, thinking: agent.state.thinkingLevel, turns, durationMs: Math.round(performance.now() - startedAt), limited: !!limit, ...(limit && { limit }), usage: subagentUsage(messages), task: input.task.slice(0, 500) } };
	}

	/** Stops a run that has gone past the turn budget, keeps issuing the identical tool call/cycle, or repeats the same tool error. */
	private guardRunaway(sessionId: string, live: Live, event: Extract<AgentEvent, { type: "turn_end" }>): void {
		const limits = { maxTurns: MAX_RUN_TURNS, maxRepeated: MAX_REPEATED_CALLS };
		const rawContent = (event.message as { content?: unknown }).content;
		const callArgsById = new Map<string, unknown>();
		if (Array.isArray(rawContent)) {
			for (const block of rawContent as { type?: unknown; id?: unknown; arguments?: unknown }[]) {
				if (block?.type === "toolCall" && typeof block.id === "string") {
					callArgsById.set(block.id, block.arguments);
				}
			}
		}
		const errorParts = event.toolResults
			.filter((r) => r.isError)
			.map((r) => {
				const firstText = Array.isArray(r.content) ? r.content.find((b) => b.type === "text") : undefined;
				const msg = firstText && "text" in firstText ? String(firstText.text).trim().slice(0, 200) : "";
				const args = callArgsById.get(r.toolCallId);
				return `${r.toolName}:${JSON.stringify(args ?? {})}:${msg}`;
			});
		const errorSignature = errorParts.length ? errorParts.join("|") : undefined;
		const next = afterTurn(live, rawContent, limits, errorSignature);
		live.turns = next.turns;
		live.recentCalls = next.recentCalls;
		live.cycleWindow = next.cycleWindow ?? [];
		live.recentErrors = next.recentErrors ?? [];
		const reason = runawayReason(live, limits);
		if (!reason || !live.running) return;
		live.limitReason = reason;
		this.bus.publish(sessionId, "run_limit", { reason, turns: live.turns });
		this.abortRun(sessionId, live, "limit");
	}

	/** `tool_call` hooks + built-in bash guard. Shared by the session agent and its subagents so a policy cannot be sidestepped. */
	private async extensionToolCall(sessionId: string, { toolCall, args }: { toolCall: { id: string; name: string }; args: unknown }): Promise<{ block: true; reason: string } | undefined> {
		if (this.ext?.has("tool_call")) {
			let blocked: { block: true; reason: string } | undefined;
			await this.ext.emit("tool_call", { sessionId, toolCallId: toolCall.id, toolName: toolCall.name, args }, sessionId, (r) => {
				if (r.block) { blocked = { block: true, reason: r.reason ?? `"${toolCall.name}" was blocked by an extension` }; return true; }
			});
			if (blocked) return blocked;
		}
		if (toolCall.name === "bash" && this.guard) {
			const cmd = args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string" ? (args as { command: string }).command : "";
			const reason = cmd ? this.guard.check(cmd) : null;
			if (reason) return { block: true, reason };
		}
		return undefined;
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
		const base = this.ext ? this.ext.toolDefs() : TOOL_DEFS;
		const defs = this.mcp ? { ...this.mcp.toolDefs(), ...base } : base;
		// Only while an image model is set; an extension tool of the same name wins.
		return this.imageModel?.resolve() && !defs[IMAGE_TOOL] ? { ...defs, [IMAGE_TOOL]: imageTool(this.registry, this.imageModel) } : defs;
	}

	/** Per-run system prompt tweaks, cache-safe pruning, ephemeral goal note, and the `context` hook (never stored). */
	private async transformContext(sessionId: string, messages: AgentMessage[]): Promise<AgentMessage[]> {
		const live = this.live.get(sessionId);
		let out = messages;
		const sys = live?.runSystem;
		if (sys && out[0]?.role === "system") {
			const head = out[0] as { content?: unknown };
			const base = typeof head.content === "string" ? head.content : "";
			const body = `${sys.replace ?? base}${sys.append ?? ""}`;
			out = [{ ...out[0], content: body } as AgentMessage, ...out.slice(1)];
		}
		out = withoutNotes(out);
		const rec = this.store.get(sessionId);
		const model = rec ? this.registry.models.getModel(rec.provider, rec.model) : undefined;
		if (live) {
			out = pruneOldToolResults(out, {
				contextWindow: model?.contextWindow,
				state: live.pruneState,
			}).messages;
		}
		if (live && !live.runGoalNote) {
			const freshGoalNote = this.goals?.systemNote(sessionId);
			if (freshGoalNote) {
				let lastUserTs: number | undefined;
				for (let i = out.length - 1; i >= 0; i--) {
					if (out[i]?.role === "user") {
						lastUserTs = (out[i] as { timestamp?: number }).timestamp;
						break;
					}
				}
				live.runGoalNote = { note: freshGoalNote, userTimestamp: lastUserTs };
			}
		}
		const goalAnchor = live?.runGoalNote;
		if (goalAnchor?.note) {
			let anchorIdx = -1;
			if (goalAnchor.userTimestamp !== undefined) {
				for (let i = out.length - 1; i >= 0; i--) {
					if (out[i]?.role === "user" && (out[i] as { timestamp?: number }).timestamp === goalAnchor.userTimestamp) {
						anchorIdx = i;
						break;
					}
				}
			}
			if (anchorIdx === -1) {
				for (let i = out.length - 1; i >= 0; i--) {
					if (out[i]?.role === "user") {
						anchorIdx = i;
						break;
					}
				}
			}
			if (anchorIdx !== -1) {
				const msg = out[anchorIdx] as { role?: string; content?: unknown };
				if (typeof msg.content === "string") {
					const copy = { ...msg, content: `${msg.content}\n\n${goalAnchor.note}` } as AgentMessage;
					out = [...out.slice(0, anchorIdx), copy, ...out.slice(anchorIdx + 1)];
				} else if (Array.isArray(msg.content)) {
					const copy = { ...msg, content: [...msg.content, { type: "text" as const, text: goalAnchor.note }] } as AgentMessage;
					out = [...out.slice(0, anchorIdx), copy, ...out.slice(anchorIdx + 1)];
				}
			}
		}
		const resize = model?.inputLimits?.images?.resize;
		out = await fitImagesInContext(out, resize ?? {});
		if (this.ext?.has("context")) {
			await this.ext.emit("context", { sessionId, messages: out }, sessionId, (r) => {
				if (Array.isArray(r.messages)) out = r.messages;
			});
		}
		return out;
	}

	private onAgentEvent(sessionId: string, live: Live, event: AgentEvent): void {
		this.forwardToExtensions(sessionId, event);
		const pub = (type: string, data: unknown, opts: { ephemeral?: boolean; persistData?: unknown } = {}) =>
			this.bus.publish(sessionId, type, data, opts);

		switch (event.type) {
			case "message_update":
				pub("message_update", { message: undefined, event: slimAssistantEvent(event.assistantMessageEvent) }, { ephemeral: true });
				return;
			case "tool_execution_update":
				pub("tool_execution_update", { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult }, { ephemeral: true });
				return;
			case "message_start":
				// Replay only inspects `message.role` to open a stream bubble; avoid persisting full message content twice.
				pub(
					"message_start",
					{ message: stripToolMessageImages(event.message) },
					{ persistData: { message: { role: event.message.role } } },
				);
				return;
			case "tool_execution_end":
				pub(
					"tool_execution_end",
					{ ...event, result: stripOversizedToolResultImages(event.result) },
					{ persistData: { ...event, result: stripToolResultImages(event.result) } },
				);
				return;
			case "message_end": {
				if (live.pendingPrompt && event.message.role === "user") {
					live.pendingPrompt = undefined;
					this.store.clearPendingPrompt(sessionId);
				}
				if (live.stopCause === "shutdown") {
					if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
						event.message.stopReason = "error";
						event.message.errorMessage = SHUTDOWN_RUN_ERROR;
					} else if (event.message.role === "toolResult" && event.message.isError) {
						const first = Array.isArray(event.message.content) ? event.message.content[0] : undefined;
						if (first?.type === "text") {
							first.text = rewriteShutdownToolText(first.text, SHUTDOWN_TOOL_ERROR);
						}
					}
				}
				const seq = live.nextSeq++;
				if (live.recallCandidate && event.message === live.recallCandidate.message) {
					live.recallCandidate.userSeq = seq;
				}
				// Remember the reasoning strength this reply was written with (the session's setting can change later).
				const st = live.agent.state;
				if (event.message.role === "assistant" && st.model?.reasoning && st.thinkingLevel && st.thinkingLevel !== "off") {
					(event.message as { thinkingLevel?: string }).thinkingLevel = st.thinkingLevel;
				}
				this.store.appendMessage(sessionId, seq, event.message);
				if (event.message.role === "user" && live.origin !== "goal") {
					this.describer.maybeRefresh(sessionId);
				}
				if (event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
					const u = (event.message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage;
					const turnInput = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
					if (u && turnInput > 0) {
						live.cacheStats.turns++;
						live.cacheStats.input += u.input ?? 0;
						live.cacheStats.cacheRead += u.cacheRead ?? 0;
						live.cacheStats.cacheWrite += u.cacheWrite ?? 0;
						const totalInput = live.cacheStats.input + live.cacheStats.cacheRead + live.cacheStats.cacheWrite;
						live.cacheStats.hitRate = totalInput > 0 ? live.cacheStats.cacheRead / totalInput : 0;
						if (this.cfg.logLevel === "debug") {
							console.debug(`[cache] session=${sessionId} turn=${live.cacheStats.turns} cacheRead=${u.cacheRead ?? 0} cacheWrite=${u.cacheWrite ?? 0} input=${u.input ?? 0} hitRate=${(live.cacheStats.hitRate * 100).toFixed(1)}%`);
						}
					}
				}
				if (this.goals) {
					const m = event.message;
					if (m.role === "assistant") {
						const blocks = Array.isArray(m.content) ? m.content : [];
						const hasToolCalls = blocks.some((b) => b?.type === "toolCall");
						const textLength = blocks.reduce((sum, b) => sum + (b?.type === "text" ? String(b.text ?? "").trim().length : 0), 0);
						this.goals.onMessageEnd(sessionId, { role: "assistant", hasToolCalls, textLength });
					} else if (m.role === "toolResult") {
						this.goals.onMessageEnd(sessionId, { role: "toolResult" });
					}
				}
				pub("message_end", { seq, message: stripToolMessageImages(event.message) });
				this.ext?.notify("message_end", { sessionId, message: event.message, seq }, sessionId);
				return;
			}
			case "agent_end":
				pub("agent_end", { messageCount: event.messages.length });
				return;
			case "turn_end":
				// Replay/extensions only consume the turn_end marker; message_end already persists each message and tool result.
				pub(
					"turn_end",
					{ ...event, toolResults: event.toolResults.map(stripToolMessageImages) },
					{ persistData: { type: "turn_end", toolResults: [] } },
				);
				this.guardRunaway(sessionId, live, event);
				return;
			default:
				pub(event.type, event);
		}
	}

	/**
	 * Moves the session to another working tree of its repository (`target`), or home (null). Shared by the agent's
	 * `workdir` tool and the user (PATCH workDir).
	 */
	moveWorkdir(id: string, target: string | null, by: "agent" | "user"): { record: SessionRecord; note: string } {
		return this.workdirOps.move(id, target, by);
	}

	/** The working trees the session may move to, its own first, with the one it works in now marked. */
	workdirs(id: string): { path: string; branch: string | null; home: boolean; current: boolean }[] {
		return this.workdirOps.list(id);
	}

	/**
	 * The session agent's `afterToolCall`: extension `tool_result` hooks, then a hint when the call worked in another
	 * working tree of the repository without moving there (the agent decides whether to; see `workdir`).
	 */
	private async afterSessionTool(sessionId: string, c: Parameters<SessionManager["extensionToolResult"]>[1]) {
		const out = await this.extensionToolResult(sessionId, c);
		const failed = out?.isError ?? c.isError;
		if (!failed && (c.toolCall.name === "write" || c.toolCall.name === "edit" || c.toolCall.name === "bash")) {
			const touched = c.args && typeof c.args === "object" && typeof (c.args as { path?: unknown }).path === "string"
				? (c.args as { path: string }).path
				: null;
			this.bus.publish(sessionId, "workspace_changed", { tool: c.toolCall.name, path: touched }, { ephemeral: true });
		}
		// the worktree it worked in was removed (by this very call, often): home, and the result says so
		this.workdirOps.homeIfGone(sessionId);
		let note = this.workdirOps.takeNote(sessionId) ?? null;
		const rec = this.store.get(sessionId);
		const live = this.live.get(sessionId);
		if (!note && !failed && rec && live && c.toolCall.name !== WORKDIR_TOOL) {
			note = this.workdirOps.stayHintFor(rec, c.toolCall.name, c.args);
			if (note && live.hinted?.has(note)) note = null;
			else if (note) (live.hinted ??= new Set()).add(note); // once per place per run: a hint on every call is noise
		}
		if (!note) return out;
		const content = (out?.content ?? c.result.content) as { type: string }[];
		return { ...out, content: [...(Array.isArray(content) ? content : []), { type: "text" as const, text: note }] };
	}

	/**
	 * Sends a session home if its active worktree disappeared, tracks `live.toolsDir`, and rebuilds
	 * `live.agent.state.tools` mid-run only when `live.toolsDirty` was set and the effective tool names changed.
	 */
	private retargetTools(sessionId: string): AgentTool<any>[] | undefined {
		const live = this.live.get(sessionId);
		this.workdirOps.homeIfGone(sessionId);
		const rec = this.store.get(sessionId);
		if (!live || !rec) return undefined;
		live.toolsDir = workDirOf(rec);
		if (!live.toolsDirty) return undefined;
		live.toolsDirty = false;
		const snap = this.store.context(sessionId);
		if (!snap) return undefined;
		const defs = this.toolDefs();
		const prevNames = live.agent.state.tools.map((t) => t.name);
		// Compare defined tool names only (parameter-only schema changes take effect on the next idle rebuild).
		const nextNames = enabledTools(this.toolPlan(snap.tools)).filter((n) => Boolean(defs[n]));
		if (prevNames.length === nextNames.length && prevNames.every((n, i) => n === nextNames[i])) return undefined;
		const tools = this.sessionTools(sessionId, snap.tools, live.toolsDir, live.readTracker);
		live.agent.state.tools = tools;
		return tools;
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

	/** The configured chat models (credentials present, no image models), cached briefly for `peer(action="list_models")` and runtime error hints. */
	async refreshChatModels(): Promise<void> {
		if (Date.now() - this.chatModelsAt < 5_000) return;
		try {
			const all = await this.registry.models.getAvailable();
			this.chatModelIds = all.filter((m) => !this.registry.isImageModel?.(m.provider, m.id)).map((m) => `${m.provider}/${m.id}`);
			this.chatModelsAt = Date.now();
		} catch { /* keep the last list: the tool text only loses its hint */ }
	}

	/**
	 * A `model` written as provider/model with no `provider` (how the tool texts list them) is split, unless the id itself
	 * contains a slash under the provider it would fall to (an OpenRouter id like `anthropic/claude-x`).
	 */
	private splitSpec(provider: string | undefined, model: string | undefined, fallback: string | undefined): { provider?: string; model?: string } {
		if (provider || !model) return { provider, model };
		const i = model.indexOf("/");
		if (i <= 0 || (fallback && this.registry.models.getModel(fallback, model))) return { provider, model };
		return this.registry.models.getModel(model.slice(0, i), model.slice(i + 1)) ? { provider: model.slice(0, i), model: model.slice(i + 1) } : { provider, model };
	}

	private async resolveModel(provider?: string, model?: string): Promise<{ provider: string; model: string }> {
		const defaults = this.registry.defaultSelection?.();
		({ provider, model } = this.splitSpec(provider, model, defaults?.provider));
		const p = provider ?? defaults?.provider;
		const m = model ?? (!provider || provider === defaults?.provider ? defaults?.model : undefined);
		if (p && m) {
			if (!this.registry.models.getModel(p, m)) throw badRequest(`unknown model ${p}/${m}${this.availableModelsHint()}`);
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

	/** Clears per-session in-memory state; `all` (on delete) also drops cached idempotency, peer and delegate entries. */
	private clearSessionMemory(id: string, all = false): void {
		this.stopped.delete(id);
		this.describer.clear(id);
		this.workdirOps.clearNote(id);
		if (all) {
			this.delegates.forget(id);
			this.peers.forget(id);
			const prefix = `${id}\0`;
			for (const k of this.recentSends.keys()) if (k.startsWith(prefix)) this.recentSends.delete(k);
		}
	}

	private dispose(id: string): void {
		const live = this.live.get(id);
		if (!live) return;
		live.unsubscribe();
		this.live.delete(id);
	}

	private evictIdle(): void {
		const now = Date.now();
		this.pruneRecentSends(now);
		for (const [id, live] of this.live) {
			if (!live.running && now - live.lastActive > IDLE_EVICT_MS) {
				this.dispose(id);
				this.clearSessionMemory(id);
			}
		}
		this.describer.pruneFailed(now);
	}
}
