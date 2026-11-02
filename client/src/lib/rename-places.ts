/**
 * Renaming in place, from the one fixed key. F2 is fixed (see `keys.ts`) and it renames whatever is open: the row of its
 * sidebar entry, the tab of the strip above the pane, the header title, or the pane's own bar — whichever was clicked last,
 * since a macOS webview never focuses what it clicks (WebKit bug 22261) and so leaves nothing to read the focus from.
 *
 * Each of those places owns its inline field, so they register here and the window's F2 (`actions.ts`) asks the one that
 * was clicked, then the first one with something on screen.
 */
export interface RenamePlace {
	/** Which place wins when nothing was clicked: the sidebar row (0), the tab strip (1), the header title (2), a pane bar (3) */
	order: number;
	/** The part of the window this place covers, so a click there picks it */
	zone?: string;
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

/** What F2 renames right now: the place `at` (the last click) belongs to, else the first one with something on screen */
export function renameNow(at?: Element | null): { place: RenamePlace; target: { id: string; title: string } } | undefined {
	const clicked = at?.closest ? places.find((p) => p.zone && at.closest(p.zone)) : undefined;
	for (const place of clicked ? [clicked, ...places.filter((p) => p !== clicked)] : places) {
		const target = place.open();
		if (target) return { place, target };
	}
	return undefined;
}
