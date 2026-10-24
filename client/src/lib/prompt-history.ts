/**
 * Up/Down in the composer walks back through the prompts already sent in the conversation (like a shell).
 * The state is plain data so the stepping rules can be tested without a textarea.
 */
export interface PromptHistory {
	/** Index into the prompts, -1 = not browsing */
	index: number;
	/** The text this history last put in the input; anything else there means the user edited it */
	shown: string;
	/** What was typed before browsing started, restored by stepping past the newest prompt */
	draft: string;
}

export const newHistory = (): PromptHistory => ({ index: -1, shown: "", draft: "" });

export type Step = { used: false } | { used: true; text?: string };

/**
 * One arrow key press. `before` / `after` are the text before and after the caret (the selection must be collapsed).
 * `used` says the key was consumed (the caller prevents the default); `text` is the new input when it changes.
 * Mutates `h`.
 */
export function stepHistory(h: PromptHistory, key: "ArrowUp" | "ArrowDown", text: string, before: string, after: string, prompts: readonly string[]): Step {
	if (h.index >= 0 && text !== h.shown) h.index = -1; // edited since: start over from the newest
	if (key === "ArrowUp") {
		if (before.includes("\n")) return { used: false }; // still lines above the caret
		const next = h.index < 0 ? prompts.length - 1 : h.index - 1;
		if (next < 0) return { used: h.index >= 0 }; // already at the oldest
		if (h.index < 0) h.draft = text;
		h.index = next;
		h.shown = prompts[next]!;
		return { used: true, text: h.shown };
	}
	if (h.index < 0) return { used: false };
	if (after.includes("\n")) return { used: false };
	h.index++;
	if (h.index >= prompts.length) {
		h.index = -1;
		h.shown = h.draft;
	} else h.shown = prompts[h.index]!;
	return { used: true, text: h.shown };
}
