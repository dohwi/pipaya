/**
 * Strip inline base64 image blocks from `toolResult` payloads before sending transcripts or persisted events to UI
 * clients. Generated pictures are saved to disk and loaded lazily via `/sessions/:id/files`; keeping the full base64
 * in `messages` / `events` payloads adds tens of megabytes to every session open and SSE replay.
 *
 * The database `messages` table and LLM projection keep the original blocks intact so the model still sees them.
 */

function withoutImageBlocks(content: unknown): unknown[] | null {
	if (!Array.isArray(content)) return null;
	if (!content.some((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "image")) return null;
	return content.filter((c) => !c || typeof c !== "object" || (c as { type?: unknown }).type !== "image");
}

export function stripToolMessageImages<T>(message: T): T {
	if (!message || typeof message !== "object") return message;
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "toolResult") return message;
	const next = withoutImageBlocks(m.content);
	if (!next) return message;
	return { ...message, content: next };
}

export function stripToolResultImages<T>(result: T): T {
	if (!result || typeof result !== "object") return result;
	const r = result as { content?: unknown };
	const next = withoutImageBlocks(r.content);
	if (!next) return result;
	return { ...result, content: next };
}
