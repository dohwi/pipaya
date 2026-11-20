/**
 * Keyboard focus that would fall to <body> because the element holding it went away. A menu item picked from the keyboard,
 * a rename field finished with Enter or Escape, a menu fading out (Svelte makes an outro `inert`), the sidebar folding
 * into the rail: each left focus on nothing, so the next key (Tab, a typed letter, Enter) did nothing or started from the
 * top of the page. The composer only takes focus when the open conversation changes, so none of these brought it back.
 *
 * Focus goes back to the last element it was on that can still hold it (the "⋯" button a menu was opened from, the composer
 * a rename was started from), else to the open pane's own input (`home`). A blur the user made (a click on empty space, the
 * window losing focus) leaves the element where it was, so it is not touched.
 */
const HISTORY = 8;

/** Whether `el` can hold focus now: still in the page, shown, and not inside an inert part. */
export function canHoldFocus(el: Element | null | undefined): el is HTMLElement {
	// duck-typed (`focus`), not `instanceof HTMLElement`: tests hand in another window's elements
	if (!el || !el.isConnected || typeof (el as HTMLElement).focus !== "function" || el.closest("[inert]")) return false;
	if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
	return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

/**
 * Install the rescue on `doc`. `home` is the open pane's input (composer or terminal), the landing when nothing focused
 * before can hold focus any more. `enabled` false skips it (touch: focusing a field there pops the on-screen keyboard).
 * `holds` says whether an element can hold focus (`canHoldFocus`; tests without layout pass their own). Returns the
 * uninstaller.
 */
export function installFocusRescue(
	doc: Document,
	home: () => HTMLElement | null,
	enabled: () => boolean = () => true,
	holds: (el: Element | null | undefined) => el is HTMLElement = canHoldFocus,
): () => void {
	const win = doc.defaultView;
	if (!win) return () => {};
	// most recent first; WeakRefs so a removed subtree is not kept alive
	let history: WeakRef<HTMLElement>[] = [];
	let frame = 0;
	const onIn = (e: FocusEvent) => {
		const el = e.target as HTMLElement | null;
		if (!el || typeof el.focus !== "function") return;
		history = [new WeakRef(el), ...history.filter((r) => r.deref() !== el && r.deref()?.isConnected)].slice(0, HISTORY);
	};
	const onOut = (e: FocusEvent) => {
		// focus moved straight to something else: nothing was lost
		if (e.relatedTarget) return;
		const from = e.target as Element | null;
		win.cancelAnimationFrame(frame);
		// look once the change that took focus away has been drawn: a rename field replacing its row focuses itself in that
		// same update, and an element only being hidden by a transition loses focus a little later
		frame = win.requestAnimationFrame(() => {
			if (!enabled() || (doc.activeElement && doc.activeElement !== doc.body)) return;
			if (!doc.hasFocus() || holds(from)) return;
			const back = history.map((r) => r.deref()).find((el) => el !== from && holds(el)) ?? home();
			if (holds(back)) back.focus({ preventScroll: true });
		});
	};
	doc.addEventListener("focusin", onIn, true);
	doc.addEventListener("focusout", onOut, true);
	return () => {
		win.cancelAnimationFrame(frame);
		doc.removeEventListener("focusin", onIn, true);
		doc.removeEventListener("focusout", onOut, true);
	};
}
