/**
 * Fades the edge of a sideways scroller that hides content, so a cut-off tab reads as "more this way" rather than as a
 * clipped box. Only the hidden side fades (like the queued list's top/bottom). Sets `data-fade-start` / `data-fade-end`
 * on the node; the mask itself is the `.edge-fade` rule in app.css.
 */
export function edgeFade(node: HTMLElement) {
	const sync = () => {
		const max = node.scrollWidth - node.clientWidth;
		node.toggleAttribute("data-fade-start", node.scrollLeft > 1);
		node.toggleAttribute("data-fade-end", max - node.scrollLeft > 1);
	};
	node.classList.add("edge-fade");
	node.addEventListener("scroll", sync, { passive: true });
	const size = new ResizeObserver(sync);
	size.observe(node);
	// tabs come and go, chips appear when a group is enlarged: the content changes size without the node doing so
	const kids = new MutationObserver(() => requestAnimationFrame(sync));
	kids.observe(node, { childList: true, subtree: true });
	sync();
	return {
		destroy() {
			node.removeEventListener("scroll", sync);
			size.disconnect();
			kids.disconnect();
		},
	};
}

/**
 * Top/bottom counterpart of `edgeFade` for vertical scrollers: sets `data-fade-top` / `data-fade-bottom` on the
 * `.vfade` host (the closest `.vfade` ancestor, else the parent) while content is hidden above / below. The gradient
 * overlays themselves are the `.vfade` rules in app.css.
 */
export function verticalFade(node: HTMLElement) {
	const host = node.closest<HTMLElement>(".vfade") ?? node.parentElement;
	if (!host) return { destroy() {} };
	let raf = 0;
	const sync = () => {
		raf = 0;
		const max = node.scrollHeight - node.clientHeight;
		if (node.clientHeight === 0 || max <= 1) {
			host.removeAttribute("data-fade-top");
			host.removeAttribute("data-fade-bottom");
			return;
		}
		host.toggleAttribute("data-fade-top", node.scrollTop > 1);
		host.toggleAttribute("data-fade-bottom", max - node.scrollTop > 1);
	};
	const schedule = () => {
		if (!raf) raf = requestAnimationFrame(sync);
	};
	node.addEventListener("scroll", schedule, { passive: true });
	const size = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
	size?.observe(node);
	const kids = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
	kids?.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
	sync();
	return {
		destroy() {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			node.removeEventListener("scroll", schedule);
			size?.disconnect();
			kids?.disconnect();
			host.removeAttribute("data-fade-top");
			host.removeAttribute("data-fade-bottom");
		},
	};
}
