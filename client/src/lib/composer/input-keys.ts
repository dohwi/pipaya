import type { RunningEnterMode, SendKeyMode } from "../ux-prefs";

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

export type EdgeNavTarget = "line-start" | "line-end" | "doc-start" | "doc-end";

export interface EdgeNavAction {
	target: EdgeNavTarget;
	extend: boolean;
}

/**
 * Line- and document-edge navigation shortcuts (`Home`/`End`, `Ctrl+Home`/`End`, and macOS `⌘←`/`⌘→`/`⌘↑`/`⌘↓`).
 * Chromium and WebKit mishandle native line-boundary movement around `contenteditable="false"` inline-flex token chips
 * (e.g. `End` getting stuck before a leading `@mention` chip, or `Home` jumping to the previous line after a chip).
 */
export function edgeNavKey(
	e: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode?: number },
	composing: boolean,
	mac: boolean,
): EdgeNavAction | null {
	if (composing || e.isComposing || e.keyCode === 229 || e.altKey) return null;
	if ((e.key === "Home" || e.key === "End") && !e.metaKey) {
		if (e.ctrlKey) {
			if (mac) return null;
			return { target: e.key === "Home" ? "doc-start" : "doc-end", extend: e.shiftKey };
		}
		return { target: e.key === "Home" ? "line-start" : "line-end", extend: e.shiftKey };
	}
	if (mac && e.metaKey && !e.ctrlKey) {
		if (e.key === "ArrowLeft") return { target: "line-start", extend: e.shiftKey };
		if (e.key === "ArrowRight") return { target: "line-end", extend: e.shiftKey };
		if (e.key === "ArrowUp") return { target: "doc-start", extend: e.shiftKey };
		if (e.key === "ArrowDown") return { target: "doc-end", extend: e.shiftKey };
	}
	return null;
}

/** What an Enter press (already known not to be mid-composition and not on a touch device) does. */
export type EnterPlan = "queue" | "newline" | "command" | "steer" | "send";

/**
 * Decide what an Enter press in the composer should do given the user's send-key and mid-run preferences:
 *  - `sendKey === "enter"` (default): `Enter` sends (or steers/queues while running per `runningEnter`), `Shift+Enter`
 *    inserts a newline, and `queueCombo` (e.g. `Alt+Enter`) performs the opposite mid-run action (queue vs steer).
 *  - `sendKey === "mod-enter"`: `Ctrl/⌘+Enter` (`Mod+Enter`) sends (or steers/queues while running), plain `Enter` and
 *    `Shift+Enter` insert a newline, and a distinct `queueCombo` performs the opposite mid-run action.
 *  - A known slash command runs locally even mid-run (`/stop`, ...); unrecognized `/...` inputs send as text.
 */
export function enterPlan(s: {
	running: boolean;
	combo: string;
	queueCombo: string | undefined;
	shift: boolean;
	isCommand: boolean;
	sendKey?: SendKeyMode;
	runningEnter?: RunningEnterMode;
}): EnterPlan {
	const sendKey = s.sendKey ?? "enter";
	const runningEnter = s.runningEnter ?? "steer";
	const primaryRun: EnterPlan = runningEnter === "queue" ? "queue" : "steer";
	const altRun: EnterPlan = runningEnter === "queue" ? "steer" : "queue";

	if (sendKey === "mod-enter") {
		if (s.running && s.queueCombo && s.combo !== "Mod+Enter" && s.combo === s.queueCombo) {
			return altRun;
		}
		if (s.combo === "Mod+Enter") {
			if (s.isCommand) return "command";
			return s.running ? primaryRun : "send";
		}
		return "newline";
	}

	if (s.running && s.queueCombo && s.combo !== "Enter" && s.combo === s.queueCombo) return altRun;
	if (s.shift) return "newline";
	if (s.isCommand) return "command";
	return s.running ? primaryRun : "send";
}

/**
 * Whether an Enter pressed mid-IME composition should be deferred to run right after Hangul commits.
 * Never defers combinations that only insert a newline (e.g. Shift+Enter, or plain Enter in `mod-enter` mode).
 */
export function shouldDeferEnter(s: {
	running: boolean;
	combo: string;
	queueCombo: string | undefined;
	shift: boolean;
	sendKey?: SendKeyMode;
}): boolean {
	if (s.shift) return false;
	if ((s.sendKey ?? "enter") === "mod-enter") {
		if (s.combo === "Mod+Enter") return true;
		return Boolean(s.running && s.queueCombo && s.combo !== "Enter" && s.combo === s.queueCombo);
	}
	return true;
}

type Item = { kind: string; text?: string; goal?: boolean };

/** The prompts already sent in a conversation, oldest first, consecutive repeats and blanks dropped (what Up walks back through). */
export function sentPrompts(items: readonly Item[] | undefined): string[] {
	const out: string[] = [];
	for (const it of items ?? []) if (it.kind === "user" && !it.goal && it.text?.trim() && out[out.length - 1] !== it.text) out.push(it.text);
	return out;
}

/** The most recent prompt of a conversation on one line, "" when there is none. */
export function lastPromptOf(items: readonly Item[] | undefined): string {
	if (!items) return "";
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i]!;
		// a turn the goal sent by itself is not something the person typed: skip it
		if (it.kind === "user" && !it.goal) return (it.text ?? "").replace(/\s+/g, " ").trim();
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
