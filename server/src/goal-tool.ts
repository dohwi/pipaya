import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import Type, { type TSchema } from "typebox";
import { MAX_GOAL_OBJECTIVE } from "./shared/goals.ts";
import type { GoalRecord } from "./goals.ts";
import type { ToolDef } from "./tools.ts";

/**
 * `goal`: inspect, create, or finish/block/pause this session's long-running goal.
 * Matches Pipaya's action-dispatched built-in tool pattern (`peer`, `schedule`, `workdir`).
 */
export const GOAL_TOOL = "goal";

export interface GoalOps {
	get(): GoalRecord | null;
	create(objective: string, tokenBudget?: number | null): GoalRecord;
	update(status: "complete" | "blocked" | "paused"): GoalRecord;
}

const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;
const text = (t: string, details: Record<string, unknown> = {}): AgentToolResult<any> => ({ content: [{ type: "text", text: t }], details });

function formatGoal(g: GoalRecord): string {
	const rem = g.tokenBudget !== null ? Math.max(0, g.tokenBudget - g.tokensUsed) : null;
	const lines = [
		`Status: ${g.status}`,
		`Objective: ${g.objective}`,
		`Tokens used: ${g.tokensUsed.toLocaleString("en-US")}`,
		...(g.tokenBudget !== null ? [`Token budget: ${g.tokenBudget.toLocaleString("en-US")} (remaining: ${rem!.toLocaleString("en-US")})`] : ["Token budget: none (unbounded)"]),
		`Time used: ${g.timeUsedSeconds}s`,
	];
	return lines.join("\n");
}

const DESCRIPTION = [
	"Manage this session's persistent goal (automatic turn-by-turn continuation until the objective is met). Pick `action`:",
	"get: read the current session goal, status, token usage/budget, and elapsed time.",
	"create (objective, tokenBudget?): start a new goal ONLY when the user explicitly asks to set a goal and no unfinished goal exists. Set `tokenBudget` only when the user explicitly requests a token limit.",
	"update (status: complete | blocked | paused): update the current goal's status. Use `complete` ONLY after auditing every requirement against direct evidence; use `blocked` ONLY after the exact same blocking condition has repeated for at least 3 consecutive goal turns without progress; use `paused` ONLY when the user explicitly requests pausing. Resume, usage_limited, and budget_limited are controlled by the user or server.",
].join("\n");

export const goalTool: ToolDef = {
	name: GOAL_TOOL,
	description: DESCRIPTION,
	create: (_cwd, _roots, ctx) =>
		defineTool({
			name: GOAL_TOOL,
			label: "goal",
			description: DESCRIPTION,
			parameters: Type.Object({
				action: Type.Union([Type.Literal("get"), Type.Literal("create"), Type.Literal("update")], {
					description: "Action: get, create, or update",
				}),
				objective: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_GOAL_OBJECTIVE, description: "create: what must be finished" })),
				tokenBudget: Type.Optional(Type.Integer({ minimum: 1, description: "create: optional token budget limit (omit unless user asked)" })),
				status: Type.Optional(
					Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")], {
						description: "update: complete | blocked | paused",
					}),
				),
			}),
			executionMode: "sequential",
			async execute(_id, p) {
				const ops = ctx?.goals;
				if (!ops) throw new Error("goals are not enabled on this server");
				if (p.action === "get") {
					const g = ops.get();
					return g ? text(formatGoal(g), { goal: g }) : text("No goal is currently set for this session.", { goal: null });
				}
				if (p.action === "create") {
					if (!p.objective?.trim()) throw new Error("goal create requires `objective`");
					const g = ops.create(p.objective, p.tokenBudget ?? null);
					return text(`Goal started.\n${formatGoal(g)}`, { goal: g });
				}
				if (!p.status) throw new Error("goal update requires `status` (complete | blocked | paused)");
				const g = ops.update(p.status);
				const report =
					g.status === "complete"
						? `\nReport the final result along with usage (${g.tokensUsed.toLocaleString("en-US")} tokens${g.tokenBudget !== null ? ` / ${g.tokenBudget.toLocaleString("en-US")} budget` : ""}, ${g.timeUsedSeconds}s).`
						: "";
				return text(`Goal updated to ${g.status}.\n${formatGoal(g)}${report}`, { goal: g });
			},
		}),
};
