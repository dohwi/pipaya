import type { StoredMessage } from "./api";
import { parsePeer } from "./peers";

const MAX_SNIPPET = 160;

/** Pull plain text out of a stored agent message content field. */
function messagePlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) parts.push(text);
		}
	}
	return parts.join(" ");
}

/** Clean up raw message text for a compact 1–2 line hover preview snippet. */
export function cleanPreviewText(raw: string): string {
	let s = raw.replace(/<pipaya-hint>[\s\S]*?<\/pipaya-hint>/g, " ");
	const peer = parsePeer(s);
	if (peer) s = peer.body;
	s = s
		.replace(/```[\s\S]*?```/g, " [code] ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^[#>*\-\s]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (s.length <= MAX_SNIPPET) return s;
	return `${s.slice(0, MAX_SNIPPET - 1).trimEnd()}…`;
}

/** Pick the latest meaningful assistant or user line from a session's tail messages. */
export function extractPreviewSnippet(messages: readonly StoredMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant" && m.role !== "user") continue;
		const text = cleanPreviewText(messagePlainText(m.message?.content));
		if (text) return text;
	}
	return "";
}
