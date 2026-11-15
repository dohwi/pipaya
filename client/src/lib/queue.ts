import { t } from "./i18n";

export type QueuedItem = { mode: "steer" | "follow_up"; text: string; deferred?: boolean };
export type QueuedView = QueuedItem & { n: number };

/** Delivery order: steers go into the running turn first, then queued follow-ups. `n` counts per mode, from 1. */
export function orderQueued(items: readonly QueuedItem[]): QueuedView[] {
	let s = 0;
	let f = 0;
	const numbered = items.map((q) => ({ ...q, n: q.mode === "steer" ? ++s : ++f }));
	return [...numbered.filter((q) => q.mode === "steer"), ...numbered.filter((q) => q.mode !== "steer")];
}

/**
 * What a waiting message says, without the blocks the server adds for the model (`<pipaya-hint>…</pipaya-hint>` after an
 * `@name`, `<pipaya-schedule>…`): the server joins every text part of a queued message, the bubble later hides them.
 * The raw text stays the key for taking the message back (the server matches it exactly).
 */
export const queuedShown = (text: string): string => text.replace(/<pipaya-([a-z-]+)>[\s\S]*?<\/pipaya-\1>/g, "").trimEnd();

export const queuedEmoji = (mode: QueuedItem["mode"]) => (mode === "steer" ? "⚡" : "⏳");
export const queuedTone = (mode: QueuedItem["mode"]) => (mode === "steer" ? "warn" : "info");
export const queuedLabel = (q: QueuedView) => `${queuedEmoji(q.mode)} ${q.mode === "steer" ? t("끼워 넣기") : t("대기열")} ${q.n}`;
