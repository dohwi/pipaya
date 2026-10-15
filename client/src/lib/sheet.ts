/**
 * Pull-down-to-dismiss for phone bottom sheets, one implementation for every modal.
 *
 * `use:sheetPull={{ onclose }}` goes on the sheet's header (the handle). It finds the sheet itself
 * (the nearest `<dialog>` / `[role=dialog]`), and on a phone lets the finger drag it down:
 *  - the pull is written straight to the DOM as `--pull` (no component state, no re-render per move);
 *    app.css turns it into a compositor-only `transform`, so the drag never lays out;
 *  - a scrim that is the sheet's previous sibling fades with the pull;
 *  - past a distance or a flick it calls `onclose`; otherwise it eases back;
 *  - the exit transition (`modalOut`, or the CSS sheet-out of a native `<dialog>`) starts from where the finger let go.
 * Off phone (> 640px) it does nothing. Taps on buttons/fields inside the handle keep their meaning.
 */
import { isPhone } from "./motion";

export interface SheetPullOpts {
	onclose: () => void;
	/** e.g. while saving, or when the header is embedded in another surface */
	disabled?: boolean;
}

const DISTANCE = 140; // px, capped by a quarter of the sheet's height
const RATIO = 0.25;
const FLICK = 0.6; // px/ms downwards
const STALE = 100; // ms without movement: the finger has stopped, so it is not a flick
const IGNORE = "button, a, input, select, textarea, [role=button], [contenteditable]";

export function sheetPull(node: HTMLElement, initial: SheetPullOpts) {
	let opts = initial;
	const sheet = node.closest<HTMLElement>('dialog, [role="dialog"]');
	if (!sheet) return {};

	// A disabled handle (e.g. a form drawn as a page inside another dialog) must not look or act like one.
	function mark() {
		node.classList.toggle("sheet-handle", !opts.disabled);
		if (opts.disabled) delete sheet!.dataset.sheet;
		else sheet!.dataset.sheet = "";
	}
	mark();

	let id = -1;
	let y = 0;
	let startY = 0;
	let lastY = 0;
	let lastT = 0;
	let v = 0;
	let scrim: HTMLElement | null = null;

	function set(px: number) {
		y = px;
		sheet!.style.setProperty("--pull", `${px}px`);
		if (scrim) scrim.style.opacity = px ? String(Math.max(0.15, 1 - px / 500)) : "";
	}

	function down(e: PointerEvent) {
		if (opts.disabled || id !== -1 || !e.isPrimary || !isPhone()) return;
		if (e.pointerType === "mouse" && e.button !== 0) return;
		if ((e.target as Element).closest(IGNORE)) return;
		id = e.pointerId;
		node.setPointerCapture(id);
		startY = lastY = e.clientY;
		lastT = e.timeStamp;
		v = 0;
		const prev = sheet!.previousElementSibling;
		scrim = prev?.classList.contains("scrim") ? (prev as HTMLElement) : null;
		sheet!.dataset.dragging = "";
	}
	function move(e: PointerEvent) {
		if (e.pointerId !== id) return;
		const dt = e.timeStamp - lastT;
		if (dt > 0) v = (e.clientY - lastY) / dt;
		lastY = e.clientY;
		lastT = e.timeStamp;
		set(Math.max(0, e.clientY - startY));
	}
	function up(e: PointerEvent) {
		if (e.pointerId !== id) return;
		id = -1;
		delete sheet!.dataset.dragging;
		if (e.timeStamp - lastT > STALE) v = 0;
		const dismiss = e.type === "pointerup" && (y > Math.min(DISTANCE, sheet!.offsetHeight * RATIO) || v > FLICK);
		// On dismiss the offset stays, so the exit animation continues from the finger's position.
		if (dismiss) opts.onclose();
		else set(0); // eased back by the CSS transition
	}

	node.addEventListener("pointerdown", down);
	node.addEventListener("pointermove", move);
	node.addEventListener("pointerup", up);
	node.addEventListener("pointercancel", up);

	return {
		update(next: SheetPullOpts) {
			opts = next;
			mark();
		},
		destroy() {
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("pointermove", move);
			node.removeEventListener("pointerup", up);
			node.removeEventListener("pointercancel", up);
			node.classList.remove("sheet-handle");
			delete sheet.dataset.sheet;
			delete sheet.dataset.dragging;
		},
	};
}
