import type { Attachment as DraftAttachment } from "../images";
import type { FileDraft } from "../files";

export interface ComposerMemoryDraft {
	text: string;
	attachments: DraftAttachment[];
	files: FileDraft[];
	reply: { text: string; who?: string } | null;
}

const MAX_FORGOTTEN = 200;
export const MAX_MEMORY_DRAFTS = 100;
const forgottenDrafts = new Set<string>();
/** Ref-counted keys currently mounted in a live Composer pane so LRU eviction never revokes active preview blob URLs. */
const mountedDrafts = new Map<string, number>();

function releasePreviews(files: readonly FileDraft[]): void {
	for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
}

/** Mark a session draft key as actively shown by a mounted Composer pane. Returns a release function. */
export function claimMemoryDraft(sessionId: string): () => void {
	mountedDrafts.set(sessionId, (mountedDrafts.get(sessionId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const next = (mountedDrafts.get(sessionId) ?? 0) - 1;
		if (next <= 0) mountedDrafts.delete(sessionId);
		else mountedDrafts.set(sessionId, next);
	};
}

/**
 * Unsent input per session ("" = new chat); outlives the Composer component so switching sessions keeps what was typed,
 * including in-memory attachments and files. Deleted sessions drop their entry via `forgetMemoryDraft`.
 */
export const memoryDrafts = new Map<string, ComposerMemoryDraft>();

/** Store a session's unsent draft, refreshing LRU order and revoking thumbnail blob URLs of any evicted older draft. */
export function setMemoryDraft(sessionId: string, draft: ComposerMemoryDraft): void {
	memoryDrafts.delete(sessionId);
	memoryDrafts.set(sessionId, draft);
	if (memoryDrafts.size <= MAX_MEMORY_DRAFTS) return;
	for (const key of memoryDrafts.keys()) {
		if (memoryDrafts.size <= MAX_MEMORY_DRAFTS) break;
		if (key === sessionId || mountedDrafts.has(key)) continue;
		const oldest = memoryDrafts.get(key);
		memoryDrafts.delete(key);
		if (oldest) releasePreviews(oldest.files);
	}
}

/** Drop a stored memory draft and revoke any thumbnail blob URLs it owned (without marking the session deleted). */
export function releaseMemoryDraft(sessionId: string): void {
	const existing = memoryDrafts.get(sessionId);
	if (!existing) return;
	memoryDrafts.delete(sessionId);
	releasePreviews(existing.files);
}

export function isDraftForgotten(sessionId: string): boolean {
	return !!sessionId && forgottenDrafts.has(sessionId);
}

export function forgetMemoryDraft(sessionId: string): void {
	if (!sessionId) return;
	releaseMemoryDraft(sessionId);
	forgottenDrafts.add(sessionId);
	if (forgottenDrafts.size > MAX_FORGOTTEN) {
		const oldest = forgottenDrafts.values().next().value;
		if (oldest !== undefined) forgottenDrafts.delete(oldest);
	}
}
