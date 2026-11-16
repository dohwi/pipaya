/**
 * Which transcript a pane draws while the one it was switched to is still loading.
 *
 * Switching conversations used to blank the pane at once: an empty frame, then (after the skeleton's delay) bones, then
 * the messages. Keeping the conversation that was on screen for a moment, dimmed, makes a quick load a plain swap; a slow
 * one still gives way to the skeleton after `HOLD_MS`, so the old messages never pass for the new conversation's.
 */
export const HOLD_PREVIOUS_MS = 300;

export interface Shown<C> {
	/** The transcript to draw */
	chat: C | null;
	/** It is the previous conversation, kept while the new one loads (drawn dimmed, not interactive) */
	held: boolean;
	/** The previous one was held and the new one is still loading: the reader has waited already, so its skeleton shows at once */
	late: boolean;
}

/**
 * `wanted`: the pane's conversation now; `ready`: whether it has loaded; `previous`: what the pane drew last (a loaded
 * transcript of another conversation, or null); `since`: when the pane switched to `wanted`; `now`: the time.
 */
export function shownChat<C>(wanted: C | null, ready: boolean, previous: C | null, since: number, now: number, hold = HOLD_PREVIOUS_MS): Shown<C> {
	const holding = !!wanted && !ready && !!previous && previous !== wanted;
	if (holding && now - since < hold) return { chat: previous, held: true, late: false };
	return { chat: wanted, held: false, late: holding };
}
