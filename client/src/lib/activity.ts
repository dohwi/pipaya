import { t } from "./i18n";
import type { Session } from "./types";

/**
 * What a session is doing right now, in the user's terms:
 *  working  the agent is running
 *  asking   the agent is waiting for the user to answer a question
 *  done     finished since the user last looked
 *  failed   the last run ended in an error since the user last looked
 *  idle     nothing to report
 */
export type Activity = "working" | "asking" | "done" | "failed" | "idle";

/** Getters, so a label is in the language in effect when it is read. */
export const ACTIVITY_LABEL: Record<Activity, string> = {
	get working() { return t("작업 중"); },
	get asking() { return t("확인 필요"); },
	get done() { return t("작업 완료"); },
	get failed() { return t("실패"); },
	get idle() { return t("대기"); },
};

/** The one colour mapping for an activity state: AgentBadge, the sidebar label and the pane header all read it. */
export const ACTIVITY_TONE: Record<Activity, "neutral" | "ok" | "warn" | "danger" | "accent" | "info"> = {
	working: "info",
	asking: "warn",
	done: "ok",
	failed: "danger",
	idle: "neutral",
};

export interface ActivityView {
	running: Record<string, boolean>;
	awaiting: Record<string, number>;
	unread: Record<string, boolean>;
	failed: Record<string, boolean>;
}

export function activityOf(v: ActivityView, id: string): Activity {
	if ((v.awaiting[id] ?? 0) > 0) return "asking";
	if (v.running[id]) return "working";
	if (v.failed[id]) return "failed";
	if (v.unread[id]) return "done";
	return "idle";
}

/** Most urgent first: what to put in front of the user when a tab/rail can only show one thing. */
export const URGENCY: Activity[] = ["asking", "failed", "done", "working", "idle"];

/** The most urgent of several states (idle when none): the colour a folded row's count badge takes. */
export const mostUrgent = (states: Iterable<Activity>): Activity => {
	const have = new Set(states);
	return URGENCY.find((a) => have.has(a)) ?? "idle";
};

export function summarize(v: ActivityView, sessions: Session[]): Record<Activity, number> {
	const out: Record<Activity, number> = { working: 0, asking: 0, done: 0, failed: 0, idle: 0 };
	for (const s of sessions) out[activityOf(v, s.id)]++;
	return out;
}
