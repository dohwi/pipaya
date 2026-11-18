/**
 * Touch screens have no hover, so what a mouse user reads in a tooltip (`title`) or learns by hovering never reaches a
 * finger. Two small tools close that gap without changing how anything looks:
 *  - `tapTitle`: a tap on an element shows its `title` as a toast;
 *  - `hintOnce`: a gesture that is not visible (long-press) is explained once per device, the first time it would help.
 * Both do nothing with a mouse.
 */
import { app } from "./store.svelte";
import { isTouch } from "./format";
import { K, read, write } from "./persist";
import { takeHint, tipLine } from "./touch-hint-text";

/** Show `text` once per device, the first time it is asked for under `key` (touch only). */
export function hintOnce(key: string, text: string): void {
	if (!isTouch()) return;
	const next = takeHint(read<string[]>(K.hints, []), key);
	if (!next.show) return;
	write(K.hints, next.seen);
	app.toast(text);
}

/**
 * `use:tapTitle`: on touch, a tap on this element shows its `title` (read at tap time, so it is always current). The tap
 * still does whatever else it does (a message's tap still shows its buttons).
 */
const told = new WeakSet<Event>();
export function tapTitle(node: HTMLElement) {
	const onClick = (e: Event) => {
		// nested titles (a time inside the stats line): the innermost one is what the finger was on
		if (told.has(e)) return;
		const title = node.getAttribute("title");
		if (!title || !isTouch()) return;
		told.add(e);
		app.toast(tipLine(title));
	};
	node.addEventListener("click", onClick);
	return { destroy: () => node.removeEventListener("click", onClick) };
}
