/**
 * Pure decisions the composer's textarea makes about keys and its own history. No runes, no DOM: the component reads
 * the event and the state, asks here, and acts on the answer.
 */

/** Hangul syllables, jamo and compatibility jamo: where Enter only ends the last syllable. */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

/**
 * A composition that ended with `data`, after an Enter pressed mid-composition: should that Enter now send?
 * Hangul only: in Japanese / Chinese Enter confirms a conversion and a second Enter sends, so those keep two presses.
 */
export const hangulCommit = (data: string | null | undefined): boolean => HANGUL.test(data ?? "");

/** Up / Down may walk the prompt history: plain key, no IME in progress, nothing selected. The caret line is checked by the caller (it needs the DOM). */
export function historyKey(e: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }, composing: boolean, selectionCollapsed: boolean): e is typeof e & { key: "ArrowUp" | "ArrowDown" } {
	if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || composing || e.isComposing || !selectionCollapsed) return false;
	return e.key === "ArrowUp" || e.key === "ArrowDown";
}

/** What an Enter press (already known not to be mid-composition and not on a touch device) does. */
export type EnterPlan = "queue" | "newline" | "command" | "unknown-command" | "steer" | "send";

/**
 * Mid-run: plain Enter steers; the user's queue shortcut (Alt+Enter by default) queues for afterwards. Shift+Enter is a
 * newline. A slash command runs locally even mid-run (/stop, ...); a mistyped one is refused instead of reaching a model.
 */
export function enterPlan(s: { running: boolean; combo: string; queueCombo: string | undefined; shift: boolean; isCommand: boolean; isUnknownCommand: boolean }): EnterPlan {
	if (s.running && s.combo !== "Enter" && s.combo === s.queueCombo) return "queue";
	if (s.shift) return "newline";
	if (s.isCommand) return "command";
	if (s.isUnknownCommand) return "unknown-command";
	return s.running ? "steer" : "send";
}

type Item = { kind: string; text?: string };

/** The prompts already sent in a conversation, oldest first, consecutive repeats and blanks dropped (what Up walks back through). */
export function sentPrompts(items: readonly Item[] | undefined): string[] {
	const out: string[] = [];
	for (const it of items ?? []) if (it.kind === "user" && it.text?.trim() && out[out.length - 1] !== it.text) out.push(it.text);
	return out;
}

/** The most recent prompt of a conversation on one line, "" when there is none. */
export function lastPromptOf(items: readonly Item[] | undefined): string {
	if (!items) return "";
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i]!;
		if (it.kind === "user") return (it.text ?? "").replace(/\s+/g, " ").trim();
	}
	return "";
}

/**
 * ARIA for the textarea while the `/` `#` `@` menu is its popup: focus stays in the field, the highlight moves, so the
 * field points at the list and at the highlighted option. Closed menu: no attributes at all.
 */
export function menuAria(open: boolean, listId: string, optionId: (i: number) => string, index: number, count: number): Record<string, string> {
	if (!open) return {};
	return { role: "combobox", "aria-autocomplete": "list", "aria-controls": listId, "aria-expanded": "true", ...(count ? { "aria-activedescendant": optionId(index) } : {}) };
}
