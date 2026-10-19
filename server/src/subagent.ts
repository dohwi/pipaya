import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { DelegateReport, DelegateRequest } from "./tools.ts";
import { buildTools, type ToolDef } from "./tools.ts";
import type { ModelRegistry } from "./models.ts";
import { DEFAULT_MAX_TURNS, MUTATING_SUBAGENT_TOOLS, READ_ONLY_SUBAGENT_TOOLS, type SubAgentSettings } from "./subagent-settings.ts";

/** The tools of the default "explore" helper. A sub-agent can never start another sub-agent. */
export const SUBAGENT_TOOLS = READ_ONLY_SUBAGENT_TOOLS;
export const MAX_TURNS = DEFAULT_MAX_TURNS;
/** Output cap per model call, so one rambling step cannot burn the budget. */
export const MAX_CALL_TOKENS = 2048;
/** About 1.5k tokens: the point is a short report, not a second transcript. */
export const MAX_REPORT_CHARS = 6000;
export const MAX_TASK_CHARS = 4000;

export const SUBAGENT_PROMPT = `You are a read-only research assistant. Another agent sent you to investigate something in a codebase so it does not have to read everything itself.
Use only read, grep and ls. You cannot change anything.
Work efficiently: search first, then read only the parts you need (use read with offset and limit).
Finish with a concise report, under 300 words:
- Answer the task directly.
- Cite every claim as path:line. Quote exact text only when the exact wording matters, and keep quotes short.
- Say what you looked for and did not find. Never guess or fill gaps.
- Do not paste whole files.`;

/** Prompt for a helper that holds tools which change files or run commands. */
export const WORKER_PROMPT = (tools: readonly string[]) => `You are a helper agent. Another agent sent you to do one task so it does not have to do it itself.
Use only these tools: ${tools.join(", ")}.
Work efficiently, and do only what the task asks.
Finish with a concise report, under 300 words:
- Say what you did and what you found. List every file you changed.
- Cite findings as path:line.
- Say what failed or what you did not do. Never guess or fill gaps.`;

export const promptFor = (tools: readonly string[]) => (tools.some((t) => (MUTATING_SUBAGENT_TOOLS as readonly string[]).includes(t)) ? WORKER_PROMPT(tools) : SUBAGENT_PROMPT);

const WRAP_UP = "You are almost out of steps. Reply now with your report from what you have found. Do not call any more tools.";

export interface SubAgentRun extends DelegateRequest {
	/** Used when nothing else picks a model: the calling session's model. */
	fallback: { provider: string; model: string };
	/** Tool set including what server extensions add or replace (default: the built-in tools). */
	toolDefs?: Record<string, ToolDef>;
	/** The same tool_call / tool_result hooks the calling session runs, so a policy extension cannot be bypassed through a helper. */
	beforeToolCall?: ConstructorParameters<typeof Agent>[0]["beforeToolCall"];
	afterToolCall?: ConstructorParameters<typeof Agent>[0]["afterToolCall"];
}

/** Why a delegate call cannot run. Thrown as a plain Error so the main agent reads it as a tool error and can adapt. */
export class DelegateRefused extends Error {}

/** Cap the report and mark it when the run was cut short, so the caller knows how far to trust it. */
export function finishReport(raw: string, stoppedEarly: boolean, max = MAX_REPORT_CHARS, maxTurns = MAX_TURNS): { text: string; truncated: boolean } {
	let text = raw;
	const truncated = text.length > max;
	if (truncated) text = text.slice(0, max);
	if (!text) text = "(the sub-agent produced no report)";
	if (stoppedEarly) text += `\n[stopped at the ${maxTurns}-step limit; this report may be incomplete]`;
	if (truncated) text += "\n[report cut at the length limit]";
	return { text, truncated };
}

/** Wrapper of the note added to a user message; clients hide text blocks that start with it. */
export const HINT_OPEN = "<pipaya-hint>";

/** Names written as `/subagent:name` in a message, limited to helpers that exist, in order of appearance, without repeats. */
export function mentionedAgents(text: string, names: string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)\/subagent:([a-z0-9-]+)(?=$|[\s.,;:!?)])/g)) {
		const name = m[1]!;
		if (names.includes(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/** Tells the model the user chose these helpers by hand, so it calls `delegate` with them instead of guessing. */
export function agentHint(agents: string[]): string {
	const list = agents.map((a) => `"${a}"`).join(", ");
	return `${HINT_OPEN}The user explicitly asked for the sub-agent ${list} (written as /subagent:name). Use the delegate tool with agent=${list} for the matching part of the request.</pipaya-hint>`;
}

const textOf = (m: AgentMessage): string =>
	m.role === "assistant" ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim() : "";

/**
 * Runs a throw-away agent and hands back only its final report. Everything it reads stays in its own
 * transcript, so the calling agent pays for a short report instead of every file the search touched.
 */
export class SubAgents {
	constructor(private registry: ModelRegistry, private settings: SubAgentSettings) {}

	/** Helpers the main agent may pick right now. */
	agents(cwd?: string): { name: string; description: string }[] {
		return this.settings.available(cwd).map((a) => ({ name: a.name, description: a.description }));
	}

	/** Whether calling this helper can change files or run commands, so the caller's approval policy must apply. */
	mutates(name: string | undefined, cwd: string): boolean {
		const available = this.settings.available(cwd);
		const def = name ? available.find((a) => a.name === name) : available[0];
		return !!def && def.tools.some((t) => (MUTATING_SUBAGENT_TOOLS as readonly string[]).includes(t));
	}

	async run(req: SubAgentRun): Promise<DelegateReport> {
		const settings = this.settings.get();
		if (!settings.enabled) throw new DelegateRefused("sub-agents are switched off on this server");
		const available = this.settings.available(req.cwd);
		if (!available.length) throw new DelegateRefused("no sub-agent is enabled on this server");
		const def = req.agent ? available.find((a) => a.name === req.agent) : available[0];
		if (!def) throw new DelegateRefused(`unknown sub-agent "${req.agent}"; available: ${available.map((a) => a.name).join(", ")}`);
		const maxTurns = def.maxTurns;

		const target = this.settings.resolve(def, req.fallback);
		const model = this.registry.models.getModel(target.provider, target.model);
		if (!model) throw new Error(`sub-agent model ${target.provider}/${target.model} is not available`);
		if (!(await this.registry.models.checkAuth(target.provider))) throw new Error(`provider ${target.provider} is not configured; set its API key first`);

		const agent = new Agent({
			initialState: {
				systemPrompt: def.prompt.trim() ? `${promptFor(def.tools)}\n\n${def.prompt.trim()}` : promptFor(def.tools),
				model,
				// A model without reasoning ignores the level, so passing it is always safe.
				thinkingLevel: target.thinkingLevel,
				tools: buildTools([...def.tools], req.cwd, req.readRoots, { canSeeImages: () => model.input.includes("image"), imageLimits: () => model.inputLimits?.images?.resize }, req.toolDefs),
				messages: [],
			},
			streamFn: (m, context, options) =>
				this.registry.models.streamSimple(m, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? MAX_CALL_TOKENS, MAX_CALL_TOKENS) }),
			beforeToolCall: req.beforeToolCall,
			afterToolCall: req.afterToolCall,
		});

		let turns = 0;
		let stoppedEarly = false;
		agent.subscribe((e: AgentEvent) => {
			if (e.type !== "turn_end") return;
			turns++;
			req.onProgress?.(`step ${turns}`);
			if (turns >= maxTurns) {
				stoppedEarly = true;
				agent.abort();
			} else if (turns === maxTurns - 2 && e.toolResults.length > 0) {
				agent.steer({ role: "user", content: [{ type: "text", text: WRAP_UP }], timestamp: Date.now() });
			}
		});
		const onAbort = () => agent.abort();
		if (req.signal?.aborted) onAbort();
		req.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await agent.prompt(req.task);
			await agent.waitForIdle();
		} finally {
			req.signal?.removeEventListener("abort", onAbort);
		}
		if (req.signal?.aborted) throw new Error("Run aborted while the sub-agent was working");

		const messages = agent.state.messages;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
		for (const m of messages) {
			if (m.role !== "assistant") continue;
			usage.input += m.usage.input;
			usage.output += m.usage.output;
			usage.cacheRead += m.usage.cacheRead;
			usage.cacheWrite += m.usage.cacheWrite;
			usage.totalTokens += m.usage.totalTokens;
			usage.cost += m.usage.cost.total;
		}

		const last = messages.at(-1);
		if (!stoppedEarly && last?.role === "assistant" && last.stopReason === "error") {
			throw new Error(last.errorMessage || "the sub-agent's model call failed");
		}
		// Prefer the last answer that has text: a run cut off at the step limit may end on a tool call.
		const raw = [...messages].reverse().map(textOf).find((t) => t.length > 0) ?? "";
		const { text, truncated } = finishReport(raw, stoppedEarly, MAX_REPORT_CHARS, maxTurns);
		return { text, agent: def.name, turns, stoppedEarly, truncated, provider: target.provider, model: target.model, usage };
	}
}
