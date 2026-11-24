/**
 * Geometry helpers for hover-opened floating menus (`RowMenu`): tells whether the pointer is inside
 * the trigger or menu, within the short crossing corridor between them, or clearly outside (so a
 * missed `pointerleave` closes immediately instead of stranding the menu and its active button tint).
 */

export interface BoxRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface Point2D {
	x: number;
	y: number;
}

export const pointInRect = (pt: Point2D, r: BoxRect): boolean =>
	r.right > r.left && r.bottom > r.top && pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;

/**
 * Classifies where a mouse pointer sits relative to a hover menu and its anchor button:
 * - `"inside"`: directly over the menu or its anchor button (keep open, cancel any leave timer).
 * - `"corridor"`: within `margin` px of the union box of anchor + menu (grace period while crossing the gap).
 * - `"outside"`: clearly away from both (close immediately).
 */
export function hoverMenuZone(pt: Point2D, anchor: BoxRect | null, menu: BoxRect | null, margin = 24): "inside" | "corridor" | "outside" {
	if ((anchor && pointInRect(pt, anchor)) || (menu && pointInRect(pt, menu))) return "inside";
	const rects = [anchor, menu].filter((r): r is BoxRect => !!r && r.right > r.left && r.bottom > r.top);
	if (!rects.length) return "outside";
	const left = Math.min(...rects.map((r) => r.left)) - margin;
	const right = Math.max(...rects.map((r) => r.right)) + margin;
	const top = Math.min(...rects.map((r) => r.top)) - margin;
	const bottom = Math.max(...rects.map((r) => r.bottom)) + margin;
	return pt.x >= left && pt.x <= right && pt.y >= top && pt.y <= bottom ? "corridor" : "outside";
}

/** True when a tracked anchor shifted further than `tol` px from where the menu was placed. */
export const anchorShifted = (from: { top: number; left: number }, now: { top: number; left: number }, tol = 2): boolean =>
	Math.abs(now.top - from.top) > tol || Math.abs(now.left - from.left) > tol;
