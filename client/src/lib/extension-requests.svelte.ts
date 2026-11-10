import type { ExtensionDialogRequest } from "./extensions/host.svelte";

/**
 * What extensions ask the user, one at a time: a question (`sdk.dialog`: confirm / select / input) and an approval to
 * change app settings. The dialogs (`ExtensionDialog`, `ExtensionApproval`) show whatever is pending here and settle it;
 * a request going away closes its dialog, whoever settled it.
 */
export class ExtensionRequests {
	/** The question on screen. A second one waits its turn behind it. */
	dialog = $state<{ request: ExtensionDialogRequest; resolve(value: unknown): void } | null>(null);
	/** The settings change waiting for approval. A second one while it is open is refused (never queued behind it). */
	approval = $state<{ message: string; resolve(value: boolean): void } | null>(null);
	private queue: Promise<unknown> = Promise.resolve();

	ask(request: ExtensionDialogRequest): Promise<unknown> {
		const run = () => new Promise<unknown>((resolve) => { this.dialog = { request, resolve }; });
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => {});
		return next;
	}
	answer(value: unknown): void {
		const pending = this.dialog;
		this.dialog = null;
		pending?.resolve(value);
	}

	confirm(message: string): Promise<boolean> {
		if (this.approval) return Promise.resolve(false);
		return new Promise((resolve) => { this.approval = { message, resolve }; });
	}
	approve(approved: boolean): void {
		const pending = this.approval;
		this.approval = null;
		pending?.resolve(approved);
	}
}
