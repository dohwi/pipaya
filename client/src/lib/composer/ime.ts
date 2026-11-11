import { hangulCommit } from "./input-keys";

/**
 * IME state of the composer's textarea. While a composition runs, Enter only commits the last syllable: it is
 * remembered and acted on once the composition ends, so the user does not have to press Enter twice (Hangul only).
 */
export class Ime {
	/** A composition is in progress (`compositionstart` .. `compositionend`) */
	composing = false;
	/** Enter pressed while composing: the combo to act on when `compositionend` arrives. */
	private pending: string | null = null;

	start() {
		this.composing = true;
	}

	/** Enter arrived mid-composition (without Shift): act on it after the composition ends. */
	deferEnter(combo: string) {
		this.pending = combo;
	}

	/** The composition ended with `data`: the combo to act on now, or null. */
	end(data: string | null | undefined): string | null {
		this.composing = false;
		const combo = this.pending;
		this.pending = null;
		return combo !== null && hangulCommit(data) ? combo : null;
	}
}
