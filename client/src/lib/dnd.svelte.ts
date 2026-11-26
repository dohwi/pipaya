/**
 * Dragging a session around (from the sidebar, the folded rail, or a pane's title bar).
 *
 * This is built on pointer events instead of HTML5 drag and drop on purpose: that API does not exist on touch screens,
 * and on Android a long-press on a `draggable` element starts a *system* drag, which Samsung's One UI turns into
 * "drop it on the screen edge to open split-screen". Nothing here is `draggable`, so the system never gets involved.
 *
 *  - mouse / pen: press and move a few pixels
 *  - touch: press and hold (moving early is a scroll, and scrolls normally). With a `menu`, the hold opens it instead
 *    and moving on from there lifts the session (the menu closes); letting go keeps the menu.
 *  - a right click on a source with a `menu` opens it where the pointer is
 */
import { released } from "./pointer";
import { buzz, contextAt, swallowClick, type MenuOpener } from "./press-menu";
import { createDragGhost, type DragGhost } from "./drag-ghost";

export interface Point {
	x: number;
	y: number;
}
export interface DropOpts {
	/** Can this target take that session? When not, the next target up the tree gets a chance. */
	accepts?: (id: string) => boolean;
	/** The pointer is over the target (with where), or left it (null). */
	hover?: (pt: Point | null) => void;
	drop: (id: string, pt: Point) => void;
}
export interface SourceOpts {
	id: string;
	disabled?: boolean;
	/** Context menu: right click, long press */
	menu?: MenuOpener;
}

const targets = new WeakMap<Element, DropOpts>();

/** Marks an element as somewhere a dragged session can be let go. The innermost accepting one wins. */
export function dropTarget(node: HTMLElement, opts: DropOpts) {
	targets.set(node, opts);
	return {
		update(next: DropOpts) {
			targets.set(node, next);
		},
		destroy() {
			targets.delete(node);
		},
	};
}

const EDGE = 48; // px from a scroller's edge where dragging starts to scroll it
const HOLD_MS = 380;
const SLOP_TOUCH = 10;
const SLOP_MOUSE = 5;

class Drag {
	/** The session in the air, if any. */
	id = $state<string | null>(null);
	private cur: { el: Element; o: DropOpts } | null = null;
	private ghost: DragGhost | null = null;
	private pt: Point = { x: 0, y: 0 };
	private raf = 0;

	/** `at`: where the pointer went down, so the copy stays where it was grabbed (the pointer has moved a few px since). */
	begin(id: string, node: HTMLElement, x: number, y: number, touch: boolean, at: Point = { x, y }) {
		this.id = id;
		this.ghost = createDragGhost(node, x, y, touch, at);
		document.documentElement.classList.add("dnd");
		this.move(x, y);
		this.raf = requestAnimationFrame(this.loop);
	}

	move(x: number, y: number) {
		this.pt = { x, y };
		this.ghost?.move(x, y);
		const next = this.find(x, y);
		if (this.cur && this.cur.el !== next?.el) this.cur.o.hover?.(null);
		this.cur = next;
		next?.o.hover?.({ x, y });
	}

	/** Let go (`drop`) or give up. */
	end(drop = false) {
		const id = this.id;
		const cur = this.cur;
		const pt = this.pt;
		cancelAnimationFrame(this.raf);
		this.ghost?.remove();
		this.ghost = null;
		document.documentElement.classList.remove("dnd");
		this.cur = null;
		this.id = null;
		if (!cur) return;
		cur.o.hover?.(null);
		if (drop && id) cur.o.drop(id, pt);
	}

	private find(x: number, y: number): { el: Element; o: DropOpts } | null {
		for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
			const o = targets.get(el);
			if (o && (!o.accepts || o.accepts(this.id!))) return { el, o };
		}
		return null;
	}

	/** Near the edge of a scrolling list, the list scrolls, so a far-away row can still be reached. */
	private loop = () => {
		if (this.id === null) return;
		const { x, y } = this.pt;
		let scrolled = false;
		for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
			if (el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
			const r = el.getBoundingClientRect();
			const up = r.top + EDGE - y;
			const down = y - (r.bottom - EDGE);
			const dy = up > 0 ? -Math.ceil((Math.min(up, EDGE) / EDGE) * 14) : down > 0 ? Math.ceil((Math.min(down, EDGE) / EDGE) * 14) : 0;
			if (dy) {
				const before = el.scrollTop;
				el.scrollTop += dy;
				if (el.scrollTop !== before) {
					scrolled = true;
					this.move(x, y); // what is under the pointer changed
				}
			}
			break;
		}
		// Rows step aside while a drag hovers them, so what is under a motionless pointer can change: look again every frame
		// (a scroll above already did, hence no second pass then).
		if (!scrolled) this.move(x, y);
		this.raf = requestAnimationFrame(this.loop);
	};
}

export const drag = new Drag();

/** Pointer-downs a source already took: a source nested in another (a chip in its group's box) picks up itself, not the one around it. */
const taken = new WeakSet<Event>();

/** Makes an element pick-up-able: it carries session `id`. */
export function dragSource(node: HTMLElement, initial: SourceOpts) {
	let opts = initial;
	let st: { pid: number; touch: boolean; x: number; y: number; ox: number; oy: number; timer: number; held: boolean } | null = null;
	let active = false;

	/** What `style()` last wrote. `update` runs whenever the row's options object is rebuilt (every list change, for every row). */
	let styled: boolean | null = null;
	function style() {
		const on = !opts.disabled;
		// Writing the same three properties again still invalidated the row's style, so each list change restyled every
		// row of the sidebar (about 400 writes in the second after a send); only a change of `disabled` writes now.
		if (styled === on) return;
		styled = on;
		node.style.userSelect = on ? "none" : "";
		node.style.setProperty("-webkit-user-select", on ? "none" : "");
		node.style.setProperty("-webkit-touch-callout", on ? "none" : "");
	}
	style();

	function activate() {
		if (!st || active) return;
		active = true;
		clearTimeout(st.timer);
		if (!st.held) buzz();
		drag.begin(opts.id, node, st.x, st.y, st.touch, { x: st.ox, y: st.oy });
	}
	/** The hold is up: with a menu, a buzz says so and the finger decides (let go: the menu; move on: the session is picked up); without one, picked up at once. */
	function hold() {
		if (!st) return;
		if (!opts.menu) return opts.disabled ? undefined : activate();
		st.held = true;
		buzz();
	}
	function down(e: PointerEvent) {
		if ((opts.disabled && !opts.menu) || st || drag.id || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || taken.has(e)) return;
		if (opts.disabled && e.pointerType !== "touch") return; // mouse clicks stay normal clicks when drag is disabled; contextmenu handles right click
		taken.add(e);
		const touch = e.pointerType === "touch";
		st = { pid: e.pointerId, touch, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, timer: 0, held: false };
		if (touch) st.timer = window.setTimeout(hold, HOLD_MS);
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("touchmove", block, { passive: false });
		window.addEventListener("contextmenu", menu);
		window.addEventListener("keydown", key);
	}
	function move(e: PointerEvent) {
		if (!st || e.pointerId !== st.pid) return;
		if (released(e)) return cancel(e); // the button was let go where no pointerup reached us: drop nothing, carry nothing
		const from = { x: st.x, y: st.y };
		if (active) {
			st.x = e.clientX;
			st.y = e.clientY;
			drag.move(e.clientX, e.clientY);
			return;
		}
		if (Math.hypot(e.clientX - from.x, e.clientY - from.y) <= (st.touch ? SLOP_TOUCH : SLOP_MOUSE)) return;
		if ((st.touch && !st.held) || opts.disabled) return cleanup(); // scrolling, not dragging (or drag disabled)
		st.x = e.clientX;
		st.y = e.clientY;
		activate();
	}
	function up(e: PointerEvent) {
		if (!st || e.pointerId !== st.pid) return;
		if (active) drag.end(true);
		// the click that follows letting go (or the long press that opened the menu) is not a click on the row
		if (active || st.held) swallowClick();
		// held and let go in place: the menu opens now, where the finger was (not under it while it is still down)
		const menuAt = !active && st.held && opts.menu ? { x: st.x, y: st.y } : null;
		cleanup();
		if (menuAt) opts.menu?.(menuAt);
	}
	function cancel(e: PointerEvent) {
		if (!st || e.pointerId !== st.pid) return;
		if (active) drag.end(false);
		cleanup();
	}
	/** Once picked up (or held for the menu, so moving on can still pick it up), the finger moves the session, not the page. */
	function block(e: TouchEvent) {
		if ((active || (st?.held && !opts.disabled)) && e.cancelable) e.preventDefault();
	}
	/** The long-press that picks a session up must not also open the browser's context menu. */
	function menu(e: Event) {
		if (st?.touch || active) e.preventDefault();
	}
	function key(e: KeyboardEvent) {
		if (e.key !== "Escape" || !active) return;
		drag.end(false);
		cleanup();
	}
	function cleanup() {
		if (st) clearTimeout(st.timer);
		st = null;
		active = false;
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", cancel);
		window.removeEventListener("touchmove", block);
		window.removeEventListener("contextmenu", menu);
		window.removeEventListener("keydown", key);
	}
	/** Images and links inside would start a native drag of their own. */
	const native = (e: Event) => e.preventDefault();
	const ctx = (e: MouseEvent) => {
		if (!opts.menu || taken.has(e)) return;
		taken.add(e);
		contextAt(e, node, opts.menu);
	};

	node.addEventListener("pointerdown", down);
	node.addEventListener("dragstart", native);
	node.addEventListener("contextmenu", ctx);
	return {
		update(next: SourceOpts) {
			opts = next;
			style();
		},
		destroy() {
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("dragstart", native);
			node.removeEventListener("contextmenu", ctx);
			if (active) drag.end(false);
			cleanup();
		},
	};
}
