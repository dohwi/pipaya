/**
 * Renaming in place, from the one fixed key. F2 is fixed (see `keys.ts`) and what it renames is whatever is open: its
 * sidebar row while the sidebar shows, or the header title when it is folded away. Each of those owns its inline field, so
 * they register here and the window's F2 asks the first one that has something on screen (`actions.ts`).
 *
 * The window handler is what makes F2 work at all on macOS: a webview never focuses a button on click (WebKit bug 22261),
 * so clicking a row leaves focus on the body and the row's own keydown never runs.
 */
export interface RenamePlace {
	/** Which place wins: the sidebar row (0) before the header title (1) */
	order: number;
	/** What this place would rename right now, or null when it shows nothing to rename */
	open: () => { id: string; title: string } | null;
	/** Put that thing into its inline field (the place's own `InlineRename`) */
	start: (id: string, title: string) => void;
}

const places: RenamePlace[] = [];

/** Register a place while its component is mounted; the returned function removes it again. */
export function registerRenamePlace(place: RenamePlace): () => void {
	places.push(place);
	places.sort((a, b) => a.order - b.order);
	return () => {
		const i = places.indexOf(place);
		if (i >= 0) places.splice(i, 1);
	};
}

/** What F2 renames right now: the first place with something on screen, and that thing */
export function renameNow(): { place: RenamePlace; target: { id: string; title: string } } | undefined {
	for (const place of places) {
		const target = place.open();
		if (target) return { place, target };
	}
	return undefined;
}
