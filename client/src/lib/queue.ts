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

/**
 * One stream event applied to a session's waiting messages (the rules ChatState and the graph view share):
 * `message_queued` adds, `message_dequeued` takes one back, a delivered user message removes the one it was (a steer
 * first when both modes hold the same text: steers go in first), and the end of a run drops what it did not take, except
 * what the server holds for after it (`deferred`, unless the run was stopped). Returns the list to keep (the same one
 * when nothing changed).
 */
export function applyQueueEvent(items: QueuedItem[], type: string, d: Record<string, unknown>): QueuedItem[] {
	switch (type) {
		case "message_queued":
			return [...items, { mode: d.mode === "steer" ? "steer" : "follow_up", text: String(d.text ?? ""), ...(d.deferred ? { deferred: true } : {}) }];
		case "message_dequeued": {
			const i = items.findIndex((x) => x.mode === (d.mode === "steer" ? "steer" : "follow_up") && x.text === String(d.text ?? "") && !!x.deferred === !!d.deferred);
			return i < 0 ? items : [...items.slice(0, i), ...items.slice(i + 1)];
		}
		case "delivered": {
			const i = deliveredIndex(items, String(d.text ?? ""));
			return i < 0 ? items : [...items.slice(0, i), ...items.slice(i + 1)];
		}
		case "run_finished":
			return items.filter((x) => x.deferred && d.status !== "aborted");
		default:
			return items;
	}
}

/**
 * Which waiting message a delivered user message was: the same text, a steer first (steers go in first). The stored
 * message may carry what the server added after the typed text (`<pipaya-hint>`, a file note), so when nothing matches
 * exactly, the one it starts with counts.
 */
export function deliveredIndex<T extends { mode: string; text: string }>(items: readonly T[], delivered: string): number {
	const text = delivered.trim();
	const pick = (same: (x: T) => boolean) => {
		const sq = items.findIndex((x) => x.mode === "steer" && same(x));
		return sq >= 0 ? sq : items.findIndex(same);
	};
	const exact = pick((x) => x.text.trim() === text);
	return exact >= 0 ? exact : pick((x) => !!x.text.trim() && text.startsWith(x.text.trim()));
}

export const queuedEmoji = (mode: QueuedItem["mode"]) => (mode === "steer" ? "⚡" : "⏳");
export const queuedTone = (mode: QueuedItem["mode"]) => (mode === "steer" ? "warn" : "info");
export const queuedLabel = (q: QueuedView) => `${queuedEmoji(q.mode)} ${q.mode === "steer" ? t("끼워 넣기") : t("대기열")} ${q.n}`;
