/**
 * Strip inline base64 image blocks from `toolResult` payloads before sending transcripts or persisted events to UI
 * clients. Generated pictures are saved to disk and loaded lazily via `/sessions/:id/files`; keeping the full base64
 * in `messages` / `events` payloads adds tens of megabytes to every session open and SSE replay.
 *
 * The database `messages` table and LLM projection keep the original blocks intact so the model still sees them.
 */

/**
 * Max base64 character length (~512 KB raw binary) for an inline toolResult image sent live over SSE/WS.
 * Larger images (high-res screenshots, generated PNGs) are omitted from the live broadcast so they cannot saturate
 * slow clients' socket buffers; they are still saved on disk and loaded lazily via `/sessions/:id/files?max=...`.
 */
export const LIVE_TOOL_IMAGE_MAX_CHARS = 700_000;

function withoutImageBlocks(content: unknown, minDataLength = 0): unknown[] | null {
	if (!Array.isArray(content)) return null;
	const drop = (c: unknown) => {
		if (!c || typeof c !== "object") return false;
		const block = c as { type?: unknown; data?: unknown };
		if (block.type !== "image") return false;
		return minDataLength <= 0 || (typeof block.data === "string" && block.data.length > minDataLength);
	};
	if (!content.some(drop)) return null;
	return content.filter((c) => !drop(c));
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

export function stripOversizedToolResultImages<T>(result: T, maxChars = LIVE_TOOL_IMAGE_MAX_CHARS): T {
	if (!result || typeof result !== "object") return result;
	const r = result as { content?: unknown };
	const next = withoutImageBlocks(r.content, maxChars);
	if (!next) return result;
	return { ...result, content: next };
}
