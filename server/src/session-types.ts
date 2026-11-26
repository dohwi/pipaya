import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextPruneState } from "./context-pruning.ts";
import type { RunStopCause } from "./run-guard.ts";
import type { ModelChoiceValue } from "./model-choice.ts";
import type { SkillRef } from "./skills.ts";
import type { ThinkingLevel } from "./store.ts";
import type { ReadTrackEntry } from "./tools.ts";

/** Plain types, limits and the default prompt used by SessionManager (kept apart so the manager file is only logic). */
export const DEFAULT_SYSTEM_PROMPT = `You are a capable coding assistant working inside a sandboxed working directory.
Use the available tools to inspect and change files and run commands. Prefer small, verifiable steps.
Be concise. Paths are relative to the working directory.
When you start changing files of a task in another git worktree (usually right after \`git worktree add ../x\` for it), move this session there with the workdir tool so later calls start there and the user sees it there; move back when the task is done. To only look at or run one command in another folder, use \`cd x && …\` or absolute paths instead.
During long work, between tool calls, give a one-line progress note in plain words: what is done, rough counts, what is next (e.g. "Read 30 of 128 articles; the download is half done, next I cut the clip."). Do not narrate every call.
Files the user attaches are saved in the working directory and listed in the message. To hand a file back (a report, image, export), write it into the working directory and cite its relative path once as a markdown link, e.g. [report.pdf](out/report.pdf) or ![chart](out/chart.png); the user sees a preview, and a link to an image already renders inline (don't write both \`![](...)\` and \`[...](...)\` for the same image).`;

export const IDLE_EVICT_MS = 30 * 60_000;

/** A follow-up the server keeps itself: a command (the model never sees it), or a message queued behind one. */
export type Deferred =
	| { kind: "compact"; text: string; instructions?: string }
	| { kind: "message"; text: string; message: AgentMessage; origin: RunOrigin };

export type PromptMode = "prompt" | "steer" | "follow_up";
/**
 * Who a run is for. "peer": started by another session's message (peer send/create) or by a server report to a
 * watching session, so its result is agent-to-agent traffic. "user": everything else (the person's message, retry,
 * extension). A person's message joining a running peer run turns it into a "user" run. This is the one criterion
 * for the "no notifications for peer talk" setting: the origin of the run, not what the run did (a user run that
 * used peer tools still notifies when it ends). "schedule": started by a scheduled task. The person set it up, so it is
 * not agent-to-agent traffic: it notifies and leaves an unread mark like a "user" run; the transcript labels it.
 * One exception at the end of a run: when a user run passed work on (A → B) and a later peer run of the same session
 * passes nothing more on, that run is the result the person waits for, so its run_finished says "user" (see
 * PeerService.settleRun).
 */
export type RunOrigin = "user" | "peer" | "schedule" | "goal";

export interface CreateSessionInput {
	title?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: import("./openrouter-catalog.ts").ServiceTier | null;
	systemPrompt?: string;
	tools?: string[];
}

export interface SessionStatus {
	running: boolean;
	pendingToolCalls: string[];
	pendingQuestions: number;
	/** Partial assistant message for late-joining clients. */
	streamingMessage: AgentMessage | null;
	queued: boolean;
	/** Texts still waiting in the steer / follow-up queues, so a client that reloads can show them again. */
	queuedMessages: { mode: "steer" | "follow_up"; text: string; deferred?: boolean }[];
	lastError: string | null;
	/** A manual or automatic compaction is writing its summary. */
	compacting: boolean;
}

export interface CompactionOutcome {
	tokensBefore: number;
	context: { tokens: number | null; contextWindow: number };
	model: ModelChoiceValue & { custom: boolean };
}

export interface CacheStats {
	turns: number;
	cacheRead: number;
	cacheWrite: number;
	input: number;
	hitRate: number;
}

export interface Live {
	agent: Agent;
	nextSeq: number;
	running: boolean;
	runStartedAt: number;
	/** Who the current run is for. */
	origin: RunOrigin;
	lastActive: number;
	unsubscribe: () => void;
	/** Fingerprint of the skills and AGENTS.md files currently written into the system prompt. */
	promptKey: string;
	/** Per-session read staleness tracker shared across turns and tool calls. */
	readTracker: Map<string, ReadTrackEntry>;
	/** Cache-safe rare batched pruning state for old oversized tool results; reset on compaction. */
	pruneState: ContextPruneState;
	/** Live prompt-cache hit telemetry aggregated across assistant turns in this session. */
	cacheStats: CacheStats;
	/** Set while a compaction runs; aborting it cancels the summary call. */
	compacting?: AbortController;
	/** Set while a dropped stream waits for its retry; aborting it stops the wait and ends the run as aborted. */
	retryWait?: AbortController;
	/** Follow-ups that wait for the run to end, in the order they were typed: `/compact` and whatever was typed after it. */
	deferred?: Deferred[];
	/** Resolves when the running compaction ends (success or not); a prompt sent meanwhile waits for it. */
	compactSettled?: Promise<void>;
	/** Settles after the run's own wrap-up (run_finished) has been published, not just when the agent is idle. */
	settled?: Promise<void>;
	/** Runaway guard: model calls in this run, and the last tool-call/error fingerprints (to spot repeating loops). */
	turns: number;
	recentCalls: string[];
	cycleWindow: string[];
	recentErrors: string[];
	/** Set when abort did not take effect in time and the run was cut loose; its late wrap-up must stay silent. */
	forceStopped?: boolean;
	/** Releases `idle()` from waiting on a stuck run once `abortRun` has forcibly finalized it. */
	cutLoose?: () => void;
	/** Initial prompt message not yet persisted to `messages` (while `autoCompact` / `before_agent_start` runs). */
	pendingPrompt?: AgentMessage;
	/** Who stopped the current run from outside (first one wins); undefined when it ends by itself. */
	stopCause?: RunStopCause;
	/** The run-limit message, set together with stopCause "limit". */
	limitReason?: string;
	/** The folder the agent's tools were built for (`activeDir ?? cwd` then); they are rebuilt when it moves. */
	toolsDir: string;
	/** Hints already given this run about working in another worktree without moving there (see work-tree.ts `stayHint`). */
	hinted?: Set<string>;
	/** Set by `before_agent_start` extensions; applies to the current run only. */
	runSystem?: { replace?: string; append?: string };
	/** Goal status note snapshotted once at run start and anchored to the run's opening user message for full-prefix prompt cache stability. */
	runGoalNote?: { note: string; userTimestamp?: number };
}

/** How long a cooperative abort may take before the run is forcibly cut loose. */
export const FORCE_STOP_MS = 8000;
/** Shorter deadline on server shutdown so runs are finalized before the supervisor's SIGKILL / exit timer. */
export const SHUTDOWN_STOP_MS = 5000;

/** A single run is stopped after this many model calls (a user can simply send another message to continue). */
export const MAX_RUN_TURNS = Number(process.env.PIPAYA_MAX_RUN_TURNS) > 0 ? Number(process.env.PIPAYA_MAX_RUN_TURNS) : 200;
/** The same tool call (same name + arguments) this many turns in a row counts as a stuck loop. */
export const MAX_REPEATED_CALLS = 6;

export const promptKey = (skills: SkillRef[], instructions: { path: string; content: string }[]) =>
	JSON.stringify([skills.map((k) => [k.name, k.description, k.path]), instructions.map((i) => [i.path, i.content])]);

