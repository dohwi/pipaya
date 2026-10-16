import { t } from "./i18n";

export type QueuedItem = { mode: "steer" | "follow_up"; text: string };
export type QueuedView = QueuedItem & { n: number };

/** Delivery order: steers go into the running turn first, then queued follow-ups. `n` counts per mode, from 1. */
export function orderQueued(items: readonly QueuedItem[]): QueuedView[] {
	let s = 0;
	let f = 0;
	const numbered = items.map((q) => ({ ...q, n: q.mode === "steer" ? ++s : ++f }));
	return [...numbered.filter((q) => q.mode === "steer"), ...numbered.filter((q) => q.mode !== "steer")];
}

export const queuedEmoji = (mode: QueuedItem["mode"]) => (mode === "steer" ? "⚡" : "⏳");
export const queuedTone = (mode: QueuedItem["mode"]) => (mode === "steer" ? "warn" : "info");
export const queuedLabel = (q: QueuedView) => `${queuedEmoji(q.mode)} ${q.mode === "steer" ? t("끼워 넣기") : t("대기열")} ${q.n}`;
