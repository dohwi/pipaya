import { copyMessage, copyText } from "./clipboard";
import type { ImageBlock } from "./types";

/**
 * "Copied" feedback for a copy button: `copy(text, images?)` puts the text on the clipboard and, when that worked, `done` stays
 * true for a moment (the button shows a check mark meanwhile). A `.svelte.ts` module: `done` is a rune.
 */
export class CopyFlag {
	done = $state(false);
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly ms = 1400) {}

	/** With `images`, they go along (HTML with the pictures, read back by a pipaya input); the text alone if that fails. */
	async copy(text: string, images: readonly ImageBlock[] = []): Promise<boolean> {
		// Before any await: the rich copy needs the click that started it.
		const ok = (images.length > 0 && copyMessage(text, images)) || (await copyText(text));
		if (ok) {
			this.done = true;
			clearTimeout(this.timer);
			this.timer = setTimeout(() => (this.done = false), this.ms);
		}
		return ok;
	}

	/** Forget the pending reset (the button went away). */
	dispose(): void {
		clearTimeout(this.timer);
	}
}
