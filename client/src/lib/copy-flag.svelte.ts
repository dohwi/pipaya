import { copyText } from "./clipboard";

/**
 * "Copied" feedback for a copy button: `copy(text)` puts the text on the clipboard and, when that worked, `done` stays
 * true for a moment (the button shows a check mark meanwhile). A `.svelte.ts` module: `done` is a rune.
 */
export class CopyFlag {
	done = $state(false);
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly ms = 1400) {}

	async copy(text: string): Promise<boolean> {
		const ok = await copyText(text);
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
