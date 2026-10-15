import { isTauri } from "./tauri";

/**
 * Desktop window close goes through `ask()` first: false keeps the window open, true lets it close.
 * Closing is done with destroy() once the work is stopped, so this handler is not re-entered.
 * Returns the unlisten function.
 */
export function guardWindowClose(ask: () => Promise<boolean>): () => void {
	if (!isTauri()) return () => {};
	let off = () => {};
	let gone = false;
	void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
		const win = getCurrentWindow();
		const stop = await win.onCloseRequested(async (event) => {
			event.preventDefault();
			if (await ask()) await win.destroy();
		});
		if (gone) stop(); else off = stop;
	}).catch(() => {});
	return () => { gone = true; off(); };
}
