/**
 * Pure geometry for the stacked floating toast deck (ToastStrip.svelte).
 *
 * When collapsed, the newest toast (index 0) sits in front and up to two older toasts peek out behind it by 8px each,
 * stepping down in scale and opacity so a burst of notifications never covers the screen. Hovering (desktop) or tapping
 * once (touch) expands the deck into a vertical list with 8px gaps; every position is expressed as a `translateY` + `scale`
 * from the anchor edge so collapsed <-> expanded animates smoothly without layout jumps.
 */

export const STACK_VISIBLE = 3;
export const STACK_PEEK = 8;
export const STACK_GAP = 8;
export const STACK_SCALE_STEP = 0.05;
export const STACK_DEFAULT_HEIGHT = 44;

export interface ToastSlotLayout {
	id: number;
	index: number;
	/** Y offset in px from the anchor edge (positive downward for `top`, negative upward for `bottom`). */
	y: number;
	scale: number;
	opacity: number;
	/** Local stacking order within the deck (0..9, safe for DESIGN.md's z-index rule). */
	z: number;
	/** Older than `STACK_VISIBLE` while collapsed: hidden and non-interactive. */
	hidden: boolean;
	/** Seated behind the front card while collapsed: clipped to the front card's box. */
	behind: boolean;
}

export interface ToastStackLayout {
	height: number;
	items: ToastSlotLayout[];
}

export interface ToastAnchorBox {
	left: number;
	width: number;
	top: number;
}

/**
 * Convert a `.stage` bounding rect and any pinned top-strip bottoms into CSS coordinates for a fixed toast tray.
 * `getBoundingClientRect()` returns viewport-scaled px under CSS `html { zoom }`, while `position: fixed` `left/top/width`
 * are multiplied by `zoom` again; dividing out `zoom` keeps the tray aligned with `.stage` at every UI scale.
 */
export function stageToastBox(
	rect: { left: number; width: number; top: number },
	aboveBottoms: readonly number[] = [],
	zoom = 1,
): ToastAnchorBox {
	const z = typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
	let top = rect.top;
	for (const b of aboveBottoms) {
		if (Number.isFinite(b) && b > top) top = b;
	}
	return {
		left: Math.round(rect.left / z),
		width: Math.round(rect.width / z),
		top: Math.round(top / z),
	};
}

export function layoutToastStack(
	ids: readonly number[],
	heights: Readonly<Record<number, number>>,
	expanded: boolean,
	from: "top" | "bottom" = "top",
	defaultHeight = STACK_DEFAULT_HEIGHT,
): ToastStackLayout {
	if (ids.length === 0) return { height: 0, items: [] };
	const dir = from === "bottom" ? -1 : 1;
	const isExpanded = expanded && ids.length > 1;

	if (isExpanded) {
		let offset = 0;
		const items: ToastSlotLayout[] = ids.map((id, index) => {
			const h = heights[id] ?? defaultHeight;
			const y = offset === 0 ? 0 : dir * offset;
			offset += h + STACK_GAP;
			return {
				id,
				index,
				y,
				scale: 1,
				opacity: 1,
				z: Math.max(1, 9 - index),
				hidden: false,
				behind: false,
			};
		});
		return { height: Math.max(0, offset - STACK_GAP), items };
	}

	const frontH = heights[ids[0]!] ?? defaultHeight;
	const visibleCount = Math.min(ids.length, STACK_VISIBLE);
	const items: ToastSlotLayout[] = ids.map((id, index) => {
		const hidden = index >= STACK_VISIBLE;
		const behind = index > 0;
		const depth = Math.min(index, STACK_VISIBLE - 1);
		const scale = Math.max(0.84, Number((1 - index * STACK_SCALE_STEP).toFixed(3)));
		const opacity = hidden ? 0 : index === 0 ? 1 : index === 1 ? 0.92 : 0.78;
		return {
			id,
			index,
			y: depth === 0 ? 0 : dir * depth * STACK_PEEK,
			scale,
			opacity,
			z: hidden ? 0 : STACK_VISIBLE - index,
			hidden,
			behind,
		};
	});

	return {
		height: frontH + Math.max(0, visibleCount - 1) * STACK_PEEK,
		items,
	};
}
