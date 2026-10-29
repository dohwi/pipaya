/**
 * `use:hoverCard={() => info | null}`: a small card next to the element while the pointer is on it (mouse; the keyboard gets the
 * same card on focus, touch gets none). The card is lifted to <body> (`--z-tooltip`), so a scrolling list or a dialog's
 * overflow never clips it, and it never takes focus or pointer events.
 *
 * `info` returns the card's content: a title, chips and detail lines. The card opens on the side with room: to the
 * right of the element when it fits, else to the left, else under it.
 */
export interface HoverInfo {
	title: string;
	/** Small chips before the lines (abilities) */
	tags?: string[];
	lines: string[];
}

const GAP = 8;
const DELAY = 250;

export function hoverCard(node: HTMLElement, info: () => HoverInfo | null) {
	let card: HTMLElement | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function show() {
		const data = info();
		if (!data || card) return;
		card = document.createElement("div");
		card.className = "hovercard";
		card.setAttribute("role", "tooltip");
		const title = document.createElement("div");
		title.className = "hc-title";
		title.textContent = data.title;
		card.append(title);
		if (data.tags?.length) {
			const tags = document.createElement("div");
			tags.className = "hc-tags";
			for (const t of data.tags) {
				const chip = document.createElement("span");
				chip.textContent = t;
				tags.append(chip);
			}
			card.append(tags);
		}
		for (const line of data.lines) {
			const l = document.createElement("div");
			l.className = "hc-line";
			l.textContent = line;
			card.append(l);
		}
		document.body.append(card);
		place();
	}

	function place() {
		if (!card) return;
		const r = node.getBoundingClientRect();
		const w = card.offsetWidth;
		const h = card.offsetHeight;
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		let left = r.right + GAP;
		let top = r.top + r.height / 2 - h / 2;
		if (left + w > vw - GAP) left = r.left - GAP - w; // no room on the right: the left
		if (left < GAP) {
			// neither side fits (a narrow window): under the element, else above it
			left = Math.min(Math.max(GAP, r.left), vw - w - GAP);
			top = r.bottom + GAP + h > vh - GAP ? r.top - GAP - h : r.bottom + GAP;
		}
		top = Math.min(Math.max(GAP, top), vh - h - GAP);
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
	}

	function hide() {
		clearTimeout(timer);
		card?.remove();
		card = null;
	}
	const enter = (e: PointerEvent) => {
		if (e.pointerType !== "mouse") return;
		clearTimeout(timer);
		timer = setTimeout(show, DELAY);
	};
	// keyboard focus only: a tap focuses the button too, and a card over a touch list would only be in the way
	const focus = (e: FocusEvent) => {
		if ((e.target as HTMLElement).matches(":focus-visible")) show();
	};

	node.addEventListener("pointerenter", enter);
	node.addEventListener("pointerleave", hide);
	node.addEventListener("pointerdown", hide);
	node.addEventListener("focusin", focus);
	node.addEventListener("focusout", hide);
	return {
		destroy() {
			hide();
			node.removeEventListener("pointerenter", enter);
			node.removeEventListener("pointerleave", hide);
			node.removeEventListener("pointerdown", hide);
			node.removeEventListener("focusin", focus);
			node.removeEventListener("focusout", hide);
		},
	};
}
