import type { StoredMessage } from "./api";
import type { ChatItem } from "./types";

/**
 * The tab overview (a grid of the folder's tabs behind the count button, like a mobile browser's tab switcher): the
 * pure parts, kept out of the component so they can be tested.
 */

/** The count on the tab button: a mobile browser's square holds two digits, so past 99 it says "99+". */
export const tabCountText = (n: number): string => (n > 99 ? "99+" : String(Math.max(0, Math.floor(n))));

/** What a card shows of a conversation: who said the last thing and the start of it. */
export interface Preview {
	who: "user" | "assistant";
	text: string;
}

/** The longest preview kept: the card clamps to a few lines, so the rest is never drawn. */
export const PREVIEW_MAX = 280;

/** Markdown marks that only add noise in a three-line preview, folded into plain prose (one line, single spaces). */
export function previewText(raw: string, max = PREVIEW_MAX): string {
	const plain = raw
		.replace(/```[^\n]*\n?/g, " ") // fences: the code inside stays, the ``` lines go
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images: their alt text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: their text
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "") // heading, quote and list marks at a line start
		.replace(/(\*\*|__|~~|`)/g, "") // emphasis and inline code marks
		.replace(/<pipaya-[\w-]+>[\s\S]*?<\/pipaya-[\w-]+>/g, " ") // blocks the server adds (attached files, notes)
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** The newest message with text in a loaded transcript (the chat already on the client), or null. */
export function previewOfItems(items: readonly ChatItem[]): Preview | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i]!;
		if (it.kind === "user") {
			const text = previewText(it.text);
			if (text) return { who: "user", text };
		} else if (it.kind === "assistant") {
			const text = previewText(
				it.blocks
					.filter((b) => b.type === "text")
					.map((b) => (b as { text: string }).text)
					.join("\n\n"),
			);
			if (text) return { who: "assistant", text };
		}
	}
	return null;
}

/** The text parts of a stored message's content (a string passes through); pictures and tool calls are not text. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && c.type === "text" ? String(c.text ?? "") : "")).join("\n\n");
}

/** The same from stored messages (`GET /sessions/:id/messages?tail=N`), for a conversation that is not loaded. */
export function previewOfStored(messages: readonly StoredMessage[]): Preview | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!.message;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = previewText(contentText(m.content));
		if (text) return { who: m.role, text };
	}
	return null;
}


/** The last two steps of a path, as the header shows a working directory (`proj/app`). */
import { clampTo } from "./number";

export const shortPath = (p: string): string => p.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || p;

/**
 * Arrow keys in a grid of `cols` columns: left / right step one card (wrapping onto the next row), up / down one row
 * (staying put at the top or bottom edge), Home / End the first / last card. null for any other key.
 */
export function gridNext(key: string, index: number, count: number, cols: number): number | null {
	if (count <= 0 || index < 0) return null;
	const c = Math.max(1, cols);
	const clamp = (i: number) => clampTo(i, 0, count - 1, 0);
	switch (key) {
		case "ArrowRight":
			return clamp(index + 1);
		case "ArrowLeft":
			return clamp(index - 1);
		case "ArrowDown":
			return index + c < count ? index + c : index;
		case "ArrowUp":
			return index - c >= 0 ? index - c : index;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}
