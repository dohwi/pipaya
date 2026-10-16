const THRESHOLD = 4;

/** Mouse press-and-drag scrolls an overflow-x container sideways. Touch keeps its native scrolling.
 *  A drag that moved past the threshold swallows the click that would follow, so chips aren't activated. */
export function dragScroll(node: HTMLElement) {
	let startX = 0;
	let startLeft = 0;
	let pointerId = -1;
	let moved = false;

	function down(e: PointerEvent) {
		if (e.pointerType !== "mouse" || e.button !== 0) return;
		if (node.scrollWidth <= node.clientWidth) return;
		pointerId = e.pointerId;
		startX = e.clientX;
		startLeft = node.scrollLeft;
		moved = false;
	}
	function move(e: PointerEvent) {
		if (e.pointerId !== pointerId) return;
		const dx = e.clientX - startX;
		if (!moved) {
			if (Math.abs(dx) < THRESHOLD) return;
			moved = true;
			node.setPointerCapture(pointerId);
			node.style.cursor = "grabbing";
			node.style.userSelect = "none";
		}
		node.scrollLeft = startLeft - dx;
	}
	function end(e: PointerEvent) {
		if (e.pointerId !== pointerId) return;
		pointerId = -1;
		if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
		node.style.cursor = "";
		node.style.userSelect = "";
		// the click fires right after pointerup; drop the flag afterwards if no click came
		if (moved) setTimeout(() => (moved = false), 0);
	}
	function click(e: MouseEvent) {
		if (!moved) return;
		e.preventDefault();
		e.stopPropagation();
		moved = false;
	}

	node.addEventListener("pointerdown", down);
	node.addEventListener("pointermove", move);
	node.addEventListener("pointerup", end);
	node.addEventListener("pointercancel", end);
	node.addEventListener("click", click, true);
	return {
		destroy() {
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("pointermove", move);
			node.removeEventListener("pointerup", end);
			node.removeEventListener("pointercancel", end);
			node.removeEventListener("click", click, true);
		},
	};
}
