import type { Activity } from "./activity";
import { compact } from "./format";
import { msg, t } from "./i18n";
import type { Goal, GoalStatus } from "./types";

const LABEL: Record<GoalStatus, string> = {
	active: msg("진행 중"),
	paused: msg("일시정지"),
	blocked: msg("막힘"),
	usage_limited: msg("사용 한도"),
	budget_limited: msg("예산 소진"),
	complete: msg("달성"),
};
export const goalLabel = (s: GoalStatus) => t(LABEL[s]);

/**
 * What a goal makes of its conversation's activity (`lib/activity`), so the goal mark, the agent's logo and its `@name`
 * share one colour: an active goal keeps the agent working (blue) between its turns too; a goal that stopped short
 * (stalled, usage limit, budget spent) needs the person (amber, "확인 필요"). Paused and achieved goals add nothing.
 */
export const goalActivity = (s: GoalStatus): Activity | null =>
	s === "active" ? "working" : s === "blocked" || s === "usage_limited" || s === "budget_limited" ? "asking" : null;

/** Badge tone: the activity colours (working blue, asking amber), green once achieved, grey while paused. */
export const goalTone = (s: GoalStatus): "info" | "ok" | "neutral" | "warn" =>
	s === "active" ? "info" : s === "complete" ? "ok" : s === "paused" ? "neutral" : "warn";

/** Can be resumed (Codex: paused, stalled, usage limited). */
export const resumable = (s: GoalStatus) => s === "paused" || s === "blocked" || s === "usage_limited";

/** "1분 20초", "2시간 5분": the time the agent spent on it (idle time between turns is not counted). */
export function goalTime(sec: number): string {
	const total = Math.max(0, Math.floor(sec));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return m > 0 ? t("{h}시간 {m}분", { h, m }) : t("{h}시간", { h });
	if (m > 0) return s > 0 ? t("{m}분 {s}초", { m, s }) : t("{m}분", { m });
	return t("{s}초", { s });
}

/** What it has used, short: "142k / 500k" against its budget, else "142k · 2분 18초". */
export const goalUsage = (g: Goal) =>
	g.tokenBudget ? `${compact(g.tokensUsed)} / ${compact(g.tokenBudget)}` : `${compact(g.tokensUsed)} · ${goalTime(g.timeUsedSeconds)}`;

/** "" | warn (80% of its budget) | danger (the budget stopped it). */
export const goalLevel = (g: Goal): "" | "warn" | "danger" =>
	g.status === "budget_limited" ? "danger" : g.tokenBudget && g.tokensUsed >= g.tokenBudget * 0.8 ? "warn" : "";
