/**
 * Touch screens have no hover, so a message's copy / reply / branch buttons (shown on hover with a mouse) would stay
 * hidden. A tap on a message shows its buttons instead, one message at a time; a second tap on it hides them again.
 */
import { isTouch } from "./format";
import { tapTogglesActions } from "./reveal";

class Reveal {
	/** The message (its list key) whose buttons a tap revealed, or null. */
	key = $state<string | null>(null);

	/** A tap on message `key`. Taps on its own controls (links, buttons, fields, code) and taps that end a text selection do nothing. */
	tap(e: MouseEvent, key: string) {
		if (!isTouch() || !tapTogglesActions(e.target, getSelection()?.toString() ?? "")) return;
		this.key = this.key === key ? null : key;
	}
}

export const reveal = new Reveal();
