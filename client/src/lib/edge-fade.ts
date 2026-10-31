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
