import { t } from "./i18n";
import type { Schedule, ScheduleStatus } from "./types";

/**
 * Helpers of the scheduled-tasks page. Plain TypeScript (no runes), so they are unit-tested directly.
 * The limits mirror server/src/scheduler.ts; the server checks them again and answers 400.
 */
export const MIN_EVERY_MS = 5 * 60_000;
export const MAX_EVERY_MS = 30 * 86_400_000;
export const MAX_PROMPT = 8000;
export const MAX_TITLE = 100;
export const MAX_TASKS = 50;

export type EveryUnit = "minute" | "hour" | "day";
export const UNIT_MS: Record<EveryUnit, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** The interval as a person wrote it: an amount and a unit. */
export interface Every {
	amount: number;
	unit: EveryUnit;
}

export const everyMs = (e: Every): number => e.amount * UNIT_MS[e.unit];

/** The largest unit that divides the interval evenly: 7_200_000 -> 2 hours, 90 minutes stay minutes. */
export function splitEvery(ms: number): Every {
	for (const unit of ["day", "hour", "minute"] as const) {
		if (ms % UNIT_MS[unit] === 0 && ms >= UNIT_MS[unit]) return { amount: ms / UNIT_MS[unit], unit };
	}
	return { amount: Math.max(1, Math.round(ms / UNIT_MS.minute)), unit: "minute" };
}

/** Why an interval is not acceptable (a sentence for the form), or null when it is. A fraction, 0, NaN and out-of-range all fail. */
export function everyProblem(e: Every): string | null {
	if (!Number.isFinite(e.amount) || !Number.isInteger(e.amount) || e.amount <= 0) return t("간격은 1 이상의 정수로 입력하세요.");
	const ms = everyMs(e);
	if (ms < MIN_EVERY_MS) return t("간격은 5분 이상이어야 합니다.");
	if (ms > MAX_EVERY_MS) return t("간격은 30일 이하여야 합니다.");
	return null;
}

/** `2026-11-13T09:30` (what <input type="datetime-local"> holds, local time) -> ms; null when empty or unreadable. */
export function parseLocal(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
	const date = new Date(y, mo - 1, d, h, mi, 0, 0);
	// new Date rolls 02-31 over to 03-03: reject what did not survive
	return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi ? date.getTime() : null;
}

/** ms -> the value of <input type="datetime-local"> in local time. */
export function toLocalInput(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "10분마다", "2시간마다", "한 번". */
export function cadence(s: Pick<Schedule, "kind" | "everyMs">): string {
	if (s.kind === "once" || s.everyMs === null) return t("한 번");
	const e = splitEvery(s.everyMs);
	return e.unit === "day" ? t("{n}일마다", { n: e.amount }) : e.unit === "hour" ? t("{n}시간마다", { n: e.amount }) : t("{n}분마다", { n: e.amount });
}

export type StatusTone = "ok" | "warn" | "danger" | "neutral";

/** The last result as a short label and a Badge tone. */
export function resultOf(s: Pick<Schedule, "lastStatus" | "enabled" | "failCount" | "kind">): { label: string; tone: StatusTone } | null {
	const status: ScheduleStatus | null = s.lastStatus;
	if (!status) return null;
	switch (status) {
		case "ok": return { label: t("보냄"), tone: "ok" };
		case "skipped_busy": return { label: t("실행 중이라 건너뜀"), tone: "warn" };
		case "skipped_closed": return { label: t("닫힌 대화라 건너뜀"), tone: "warn" };
		case "skipped_expired": return { label: t("시간이 지나 건너뜀"), tone: "warn" };
		case "error": return { label: s.enabled ? t("실패 {n}회", { n: s.failCount }) : t("실패로 꺼짐"), tone: "danger" };
	}
}

/** A name for the row: the title, else the prompt's first line cut short. */
export function labelOf(s: Pick<Schedule, "title" | "prompt">, max = 60): string {
	const title = s.title?.trim();
	if (title) return title;
	const line = (s.prompt.split("\n").find((l) => l.trim()) ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Why a one-time task is not shown as "next": used up. */
export const isUsedUp = (s: Pick<Schedule, "kind" | "enabled" | "lastStatus">): boolean => s.kind === "once" && !s.enabled && s.lastStatus !== null;

/** Soonest first; switched-off ones last, in the order they were made. */
export function sortSchedules(list: readonly Schedule[]): Schedule[] {
	return [...list].sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		if (a.enabled) return (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0) || a.createdAt - b.createdAt;
		return a.createdAt - b.createdAt;
	});
}
