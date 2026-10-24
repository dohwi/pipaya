import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelChoiceValue } from "./model-choice.ts";
import type { SkillRef } from "./skills.ts";
import type { ThinkingLevel } from "./store.ts";

/** Plain types, limits and the default prompt used by SessionManager (kept apart so the manager file is only logic). */
export const DEFAULT_SYSTEM_PROMPT = `You are a capable coding assistant working inside a sandboxed working directory.
Use the available tools to inspect and change files and run commands. Prefer small, verifiable steps.
Be concise. Paths are relative to the working directory.
Files the user attaches are saved in the working directory and listed in the message. To hand a file back (a report, image, export), write it into the working directory and mention it as a markdown link to its relative path, e.g. [report.pdf](out/report.pdf) or ![chart](out/chart.png); the user sees a preview.`;

export const IDLE_EVICT_MS = 30 * 60_000;

export type PromptMode = "prompt" | "steer" | "follow_up";

export interface CreateSessionInput {
	title?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
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
	lastError: string | null;
	/** A manual or automatic compaction is writing its summary. */
	compacting: boolean;
}

export interface CompactionOutcome {
	tokensBefore: number;
	context: { tokens: number | null; contextWindow: number };
	model: ModelChoiceValue & { custom: boolean };
}

export interface Live {
	agent: Agent;
	nextSeq: number;
	running: boolean;
	runStartedAt: number;
	lastActive: number;
	unsubscribe: () => void;
	/** Fingerprint of the skills and AGENTS.md files currently written into the system prompt. */
	promptKey: string;
	/** Directories the read tool may open besides the cwd; mutated in place when skills change. */
	readRoots: string[];
	/** Set while a compaction runs; aborting it cancels the summary call. */
	compacting?: AbortController;
	/** Resolves when the running compaction ends (success or not); a prompt sent meanwhile waits for it. */
	compactSettled?: Promise<void>;
	/** Settles after the run's own wrap-up (run_finished) has been published, not just when the agent is idle. */
	settled?: Promise<void>;
	/** Runaway guard: model calls in this run, and the last tool-call fingerprints (to spot a repeating loop). */
	turns: number;
	recentCalls: string[];
	/** Set when abort did not take effect in time and the run was cut loose; its late wrap-up must stay silent. */
	forceStopped?: boolean;
	/** Set by `before_agent_start` extensions; applies to the current run only. */
	runSystem?: { replace?: string; append?: string };
}

/** How long a cooperative abort may take before the run is forcibly cut loose. */
export const FORCE_STOP_MS = 8000;

/** A single run is stopped after this many model calls (a user can simply send another message to continue). */
export const MAX_RUN_TURNS = Number(process.env.PIPAYA_MAX_RUN_TURNS) > 0 ? Number(process.env.PIPAYA_MAX_RUN_TURNS) : 200;
/** The same tool call (same name + arguments) this many turns in a row counts as a stuck loop. */
export const MAX_REPEATED_CALLS = 6;

export const promptKey = (skills: SkillRef[], instructions: { path: string; content: string }[]) =>
	JSON.stringify([skills.map((k) => [k.name, k.description, k.path]), instructions.map((i) => [i.path, i.content])]);

