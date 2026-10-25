/**
 * Context menus on things that are not text: a right click (or the keyboard's menu key) with a mouse, a long press on
 * touch. Rows that can also be dragged time their own hold in `dnd` / `block-drag` (a hold opens the menu, moving on
 * from it lifts the row); everything else uses the `pressMenu` action here.
 */
import { isEditable } from "./no-context-menu";

export interface Point {
	x: number;
	y: number;
	/** Opened from the keyboard (menu key / Shift+F10): focus goes into the menu */
	key?: boolean;
}
/** Opens a menu at `pt`; may return how to close it again (a long press that goes on to drag drops the menu). */
export type MenuOpener = (pt: Point) => (() => void) | void;

export const HOLD_MS = 380;
const SLOP = 10;

let touchedAt = 0;
if (typeof window !== "undefined")
	window.addEventListener("pointerdown", (e) => e.pointerType === "touch" && (touchedAt = Date.now()), { capture: true, passive: true });
/** A finger was down a moment ago: the `contextmenu` that follows is the long press, which the hold already handled. */
export const recentTouch = () => Date.now() - touchedAt < 1200;

/**
 * A `contextmenu` event on `node`: open the menu where the pointer is (below the element for the keyboard's menu key).
 * Text fields keep the browser's own menu (cut / copy / paste); a touch long press only loses the native one.
 */
export function contextAt(e: MouseEvent, node: Element, open: MenuOpener | undefined): void {
	if (!open || isEditable(e.target)) return;
	e.preventDefault();
	if (recentTouch()) return;
	if (e.clientX === 0 && e.clientY === 0) {
		const r = node.getBoundingClientRect();
		open({ x: r.left + 12, y: r.bottom, key: true });
		return;
	}
	open({ x: e.clientX, y: e.clientY });
}

/** A short buzz, as the system does when a long press takes. */
export const buzz = () => navigator.vibrate?.(12);

/** Turns the click that ends a long press into nothing (it is not a tap on the element). */
export function swallowClick() {
	const stop = (ev: Event) => (ev.stopPropagation(), ev.preventDefault());
	window.addEventListener("click", stop, { capture: true, once: true });
	setTimeout(() => window.removeEventListener("click", stop, true), 120);
}

/** `use:pressMenu={open}`: right click and long press open a menu for an element that is not dragged. */
export function pressMenu(node: HTMLElement, initial: MenuOpener | undefined) {
	let open = initial;
	let st: { pid: number; x: number; y: number; timer: number; held: boolean } | null = null;
	const down = (e: PointerEvent) => {
		if (!open || e.pointerType !== "touch" || !e.isPrimary || st) return;
		st = { pid: e.pointerId, x: e.clientX, y: e.clientY, timer: 0, held: false };
		st.timer = window.setTimeout(() => {
			if (!st || !open) return;
			st.held = true;
			buzz();
			open({ x: st.x, y: st.y });
		}, HOLD_MS);
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", end);
	};
	const move = (e: PointerEvent) => {
		if (st && e.pointerId === st.pid && !st.held && Math.hypot(e.clientX - st.x, e.clientY - st.y) > SLOP) end();
	};
	const up = (e: PointerEvent) => {
		if (!st || e.pointerId !== st.pid) return;
		if (st.held) swallowClick();
		end();
	};
	function end() {
		if (st) clearTimeout(st.timer);
		st = null;
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", end);
	}
	const ctx = (e: MouseEvent) => contextAt(e, node, open);
	node.addEventListener("pointerdown", down);
	node.addEventListener("contextmenu", ctx);
	node.style.setProperty("-webkit-touch-callout", "none");
	return {
		update(next: MenuOpener | undefined) {
			open = next;
		},
		destroy() {
			end();
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("contextmenu", ctx);
		},
	};
}
