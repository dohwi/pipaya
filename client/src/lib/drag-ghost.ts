/**
 * Floating copy of a dragged row (a tab, folder, or server header) that follows the pointer.
 * Keeps ancestor classes around the clone so scoped descendant CSS (`.side .dir`, `.side .item`, etc.) still matches.
 */

export interface GhostPoint {
	x: number;
	y: number;
}

export interface DragGhost {
	move(x: number, y: number): void;
	remove(): void;
}

/**
 * Empty boxes with the same classes and nesting as `node`'s ancestors (outermost first), so descendant selectors such as
 * `.side .list .item .open` or `.side .dir .dname` still match a copy placed in the innermost one. Layout properties are
 * reset so the boxes add no size of their own; only their classes matter.
 */
function scope(node: HTMLElement): { outer: HTMLElement; inner: HTMLElement } {
	const chain: HTMLElement[] = [];
	for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) chain.unshift(el);
	let outer: HTMLElement | null = null;
	let inner: HTMLElement | null = null;
	for (const el of chain) {
		const box = document.createElement("div");
		box.className = [...el.classList].join(" ");
		Object.assign(box.style, {
			display: "block",
			position: "static",
			width: "auto",
			height: "auto",
			margin: "0",
			padding: "0",
			border: "0",
			background: "none",
			overflow: "visible",
			transform: "none",
			translate: "none",
			scale: "none",
			rotate: "none",
			opacity: "1",
			boxShadow: "none",
		}); // a centred dialog (`translate: -50% -50%`) shifted the copy off the pointer
		if (inner) inner.append(box);
		else outer = box;
		inner = box;
	}
	if (!outer || !inner) outer = inner = document.createElement("div");
	return { outer, inner };
}

/**
 * Clone `node` into a fixed-position lifted ghost that hangs off the pointer (`touch`: above the finger, mouse: 24px below)
 * so the target row and drop line stay visible while dragging.
 */
export function createDragGhost(node: HTMLElement, x: number, y: number, touch: boolean, at: GhostPoint = { x, y }): DragGhost {
	const r = node.getBoundingClientRect();
	const g = node.cloneNode(true) as HTMLElement;
	g.removeAttribute("id");
	g.setAttribute("aria-hidden", "true");
	g.inert = true;
	Object.assign(g.style, {
		position: "fixed",
		left: "0",
		top: "0",
		width: `${r.width}px`,
		height: `${r.height}px`,
		margin: "0",
		pointerEvents: "none",
		// lifted off the list: opaque (a see-through copy over rows reads as a smear), the row's own corner, the theme's
		// lifted shadow and a hairline so it separates from a background of the same colour
		opacity: "1",
		background: "var(--bg-lift)",
		borderRadius: getComputedStyle(node).borderRadius,
		boxShadow: "var(--shadow), 0 0 0 1px var(--border-strong)",
		transition: "none",
	});
	// the copy shows the thing, not its state in the list (selected, hovered, a drop line)
	g.classList.remove("active", "on", "menuopen", "over", "before", "after", "carried", "focused");
	g.removeAttribute("data-hovered");
	const shell = scope(node);
	Object.assign(shell.outer.style, {
		position: "fixed",
		left: "0",
		top: "0",
		pointerEvents: "none",
		zIndex: "10000",
		willChange: "transform",
	});
	shell.outer.setAttribute("aria-hidden", "true");
	g.style.position = "relative";
	shell.inner.append(g);
	document.body.append(shell.outer);
	// Keep the spot it was grabbed by across, but hang the copy off the pointer instead of over it, so the row or tab
	// being aimed at and the line where it would land stay visible: under the pointer with a mouse, above the finger on
	// touch (where under it would be hidden by the hand).
	// Mouse: 24px below. A drop "after" a row is picked in the bottom 28% of it (9px of a 32px row) and its line is drawn
	// 12px below the row, in the middle of the 24px gap, so the copy's top (at least 24 - 9 = 15px below the row) clears it.
	const grab = { x: at.x - r.left, y: touch ? r.height + 12 : -24 };
	const move = (nx: number, ny: number) => {
		shell.outer.style.transform = `translate(${nx - grab.x}px, ${ny - grab.y}px)`;
	};
	move(x, y);
	return {
		move,
		remove: () => shell.outer.remove(),
	};
}
