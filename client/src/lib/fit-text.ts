import { schedule, unschedule } from "./frame";

/**
 * Svelte actions that fit a line of text into its row: `tail` elides the start of a path, `marquee` lets an overlong
 * title scroll past on hover. Both re-measure when the row is resized.
 */

/** The forms of a path `tail` tries, longest first: the whole path, then `…` plus ever fewer whole folders. Never a piece of a folder name. */
export function tailCandidates(full: string): string[] {
	const out = [full];
	for (const m of full.matchAll(/[\\/]/g)) if (m.index! > 0) out.push(`…${full.slice(m.index!)}`);
	return out;
}

/**
 * A path too long for its row keeps its end and drops whole folders from the start: `…/pipaya`. When not even the last folder
 * fits, the row shows nothing: half a folder name (`…rkspace`) says less than no name (the full path stays in the tooltip).
 */
export function tail(node: HTMLElement, text: string) {
	return fitTail(node, text, false);
}

/** Like `tail`, but the last folder always shows: when even it is too wide the row ends it with the CSS ellipsis instead of going blank. */
export function tailKeepLast(node: HTMLElement, text: string) {
	return fitTail(node, text, true);
}

function fitTail(node: HTMLElement, text: string, keepLast: boolean) {
	let full = text;
	const fit = () => {
		for (const c of tailCandidates(full)) {
			node.textContent = c;
			if (node.scrollWidth <= node.clientWidth) return;
		}
		const c = tailCandidates(full);
		node.textContent = keepLast ? c[c.length - 1]! : "";
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
