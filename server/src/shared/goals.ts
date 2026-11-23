/** Shared limits and status values for per-session goals (`session_goals`). */
export const GOAL_STATUSES = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Maximum objective length in characters (matches Codex `ThreadGoal`). */
export const MAX_GOAL_OBJECTIVE = 4000;
