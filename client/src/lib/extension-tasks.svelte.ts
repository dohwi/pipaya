import type { ImportResult } from "../components/extensions/ImportDialogs.svelte";

/**
 * What the extensions screen is doing right now: which keys are busy (an extension id, `$import`, `$safe`,
 * `unreadable:<n>`), the last error and notice, which card is asking about removal, and the result dialog.
 * One place for the state every action touches, so the cards and dialogs read it instead of being passed it.
 * A `.svelte.ts` module: the fields are runes, so a template reading them updates.
 */
export class ExtensionTasks {
	busy = $state<Record<string, boolean>>({});
	error = $state("");
	notice = $state("");
	/** Which card asks about removal: the extension id, or `unreadable:<index>` for an unreadable entry. */
	removing = $state<string | null>(null);
	/** What came of the last import, shown in a dialog of its own: the inline notice was easy to miss. */
	result = $state<ImportResult | null>(null);

	/** The button that opened the removal question, so focus goes back to it when the question is dismissed. */
	private trigger: HTMLElement | null = null;

	/** Open the removal question of the card `key`, remembering which button asked. */
	askRemove(key: string, event: Event): void {
		this.trigger = event.currentTarget as HTMLElement;
		this.removing = key;
	}

	/** Close the question; `refocus` puts focus back on the button that asked (after the DOM has settled). */
	cancelRemove(refocus: (back: HTMLElement | null) => void): void {
		const back = this.trigger;
		this.removing = null;
		this.trigger = null;
		refocus(back);
	}

	/** The question was answered: forget it without moving focus (the card is going away). */
	closeRemove(): void {
		this.removing = null;
		this.trigger = null;
	}

	/**
	 * Run `task` under `key`: ignored while that key is already busy; clears the old error and notice first; a failure
	 * is reported in the result dialog when `failTitle` is given, else as the inline error.
	 */
	async run(key: string, task: () => unknown | Promise<unknown>, failTitle?: string): Promise<void> {
		if (this.busy[key]) return;
		this.busy[key] = true;
		this.error = "";
		this.notice = "";
		try {
			await task();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (failTitle) this.result = { tone: "danger", title: failTitle, detail: message };
			else this.error = message;
		} finally {
			this.busy[key] = false;
		}
	}
}
