import { schedule, unschedule } from "./frame";

/**
 * Svelte actions that fit a line of text into its row: `tail` elides the start of a path, `marquee` lets an overlong
 * title scroll past on hover. Both re-measure when the row is resized.
 */

/** A path too long for its row keeps its end (the folder you are in) and elides the start: `…/pipaya` */
export function tail(node: HTMLElement, text: string) {
	let full = text;
	const fit = () => {
		node.textContent = full;
		if (node.scrollWidth <= node.clientWidth) return;
		// cut at a folder boundary: the longest tail of whole folders that fits
		const cuts = [...full.matchAll(/\//g)].map((m) => m.index!).filter((i) => i > 0);
		for (const i of cuts) {
			node.textContent = `…${full.slice(i)}`;
			if (node.scrollWidth <= node.clientWidth) return;
		}
		// even the last folder alone is too long: cut inside it
		let lo = 1;
		let hi = full.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			node.textContent = `…${full.slice(full.length - mid)}`;
			if (node.scrollWidth <= node.clientWidth) lo = mid;
			else hi = mid - 1;
		}
		node.textContent = `…${full.slice(full.length - lo)}`;
	};
	const ro = new ResizeObserver(() => schedule(node, () => fit()));
	ro.observe(node);
	fit();
	return {
		update(next: string) {
			full = next;
			fit();
		},
		destroy: () => (ro.disconnect(), unschedule(node)),
	};
}

/**
 * A title too long for its row flows past (hover/focus), looping back to its start, so the whole name can be read.
 * Idle rows keep the plain ellipsis. Only measures; the animation itself is CSS (see `.title:global([data-over])`).
 */
export function marquee(node: HTMLElement, _text: string) {
	/** Reads in the frame's read phase, writes in its write phase (lib/frame.ts), so a row that mounts or changes does not force a layout of its own. */
	const measure = (): (() => void) | void => {
		const mq = node.querySelector<HTMLElement>(".mq");
		if (!mq) return;
		// measured idle (inline, clipped): the text overflows its box only when it really does not fit
		const over = node.scrollWidth > node.clientWidth + 1;
		const duration = over ? `${Math.max(6, (mq.offsetWidth + 32) / 40)}s` : "";
		return () => {
			if (over) {
				node.dataset.over = "";
				// ~40px per second, never frantic for a title that only just overflows
				node.style.setProperty("--mq-d", duration);
			} else delete node.dataset.over;
		};
	};
	const later = () => schedule(node, measure);
	// Rows mount in bulk when a conversation appears (a send, a list reload): each measured at once, every one of them forced
	// a layout of the page. The first fit lands in the next frame instead, together with the other rows'.
	const ro = new ResizeObserver(later);
	ro.observe(node);
	later();
	return { update: later, destroy: () => (ro.disconnect(), unschedule(node)) };
}
