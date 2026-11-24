import type { Attachment as DraftAttachment } from "../images";
import type { FileDraft } from "../files";

export interface ComposerMemoryDraft {
	text: string;
	attachments: DraftAttachment[];
	files: FileDraft[];
	reply: { text: string; who?: string } | null;
}

const MAX_FORGOTTEN = 200;
const forgottenDrafts = new Set<string>();

/**
 * Unsent input per session ("" = new chat); outlives the Composer component so switching sessions keeps what was typed,
 * including in-memory attachments and files. Deleted sessions drop their entry via `forgetMemoryDraft`.
 */
export const memoryDrafts = new Map<string, ComposerMemoryDraft>();

export function isDraftForgotten(sessionId: string): boolean {
	return !!sessionId && forgottenDrafts.has(sessionId);
}

export function forgetMemoryDraft(sessionId: string): void {
	if (!sessionId) return;
	memoryDrafts.delete(sessionId);
	forgottenDrafts.add(sessionId);
	if (forgottenDrafts.size > MAX_FORGOTTEN) {
		const oldest = forgottenDrafts.values().next().value;
		if (oldest !== undefined) forgottenDrafts.delete(oldest);
	}
}
