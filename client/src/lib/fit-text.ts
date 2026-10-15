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
	const ro = new ResizeObserver(fit);
	ro.observe(node);
	fit();
	return {
		update(next: string) {
			full = next;
			fit();
		},
		destroy: () => ro.disconnect(),
	};
}

/**
 * A title too long for its row flows past (hover/focus), looping back to its start, so the whole name can be read.
 * Idle rows keep the plain ellipsis. Only measures; the animation itself is CSS (see `.title:global([data-over])`).
 */
export function marquee(node: HTMLElement, _text: string) {
	const measure = () => {
		const mq = node.querySelector<HTMLElement>(".mq");
		if (!mq) return;
		// measured idle (inline, clipped): the text overflows its box only when it really does not fit
		const over = node.scrollWidth > node.clientWidth + 1;
		if (over) {
			node.dataset.over = "";
			// ~40px per second, never frantic for a title that only just overflows
			node.style.setProperty("--mq-d", `${Math.max(6, (mq.offsetWidth + 32) / 40)}s`);
		} else delete node.dataset.over;
	};
	const ro = new ResizeObserver(measure);
	ro.observe(node);
	measure();
	return { update: () => queueMicrotask(measure), destroy: () => ro.disconnect() };
}
