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
import { buzz, contextAt, swallowClick, type MenuOpener } from "./press-menu";

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
	private ghost: HTMLElement | null = null;
	private grab: Point = { x: 0, y: 0 };
	private pt: Point = { x: 0, y: 0 };
	private raf = 0;

	begin(id: string, node: HTMLElement, x: number, y: number, touch: boolean) {
		this.id = id;
		const r = node.getBoundingClientRect();
		// a copy of what is being carried follows the pointer; on touch it rides above the finger so it stays visible
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
			zIndex: "10000",
			opacity: "0.92",
			background: "var(--bg-side)",
			borderRadius: "var(--radius)",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
			willChange: "transform",
		});
		document.body.append(g);
		this.ghost = g;
		this.grab = { x: x - r.left, y: y - r.top + (touch ? r.height / 2 + 12 : 0) };
		document.documentElement.classList.add("dnd");
		this.move(x, y);
		this.raf = requestAnimationFrame(this.loop);
	}

	move(x: number, y: number) {
		this.pt = { x, y };
		if (this.ghost) this.ghost.style.transform = `translate(${x - this.grab.x}px, ${y - this.grab.y}px)`;
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
		for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
			if (el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
			const r = el.getBoundingClientRect();
			const up = r.top + EDGE - y;
			const down = y - (r.bottom - EDGE);
			const dy = up > 0 ? -Math.ceil((Math.min(up, EDGE) / EDGE) * 14) : down > 0 ? Math.ceil((Math.min(down, EDGE) / EDGE) * 14) : 0;
			if (dy) {
				const before = el.scrollTop;
				el.scrollTop += dy;
				if (el.scrollTop !== before) this.move(x, y); // what is under the pointer changed
			}
			break;
		}
		this.raf = requestAnimationFrame(this.loop);
	};
}

export const drag = new Drag();

/** Makes an element pick-up-able: it carries session `id`. */
export function dragSource(node: HTMLElement, initial: SourceOpts) {
	let opts = initial;
	let st: { pid: number; touch: boolean; x: number; y: number; timer: number; held: boolean; unmenu?: (() => void) | void } | null = null;
	let active = false;

	function style() {
		const on = !opts.disabled;
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
		st.unmenu?.();
		drag.begin(opts.id, node, st.x, st.y, st.touch);
	}
	/** The hold is up: the menu, if there is one; otherwise the session is picked up. */
	function hold() {
		if (!st) return;
		if (!opts.menu || opts.disabled) return activate();
		st.held = true;
		buzz();
		st.unmenu = opts.menu({ x: st.x, y: st.y });
	}
	function down(e: PointerEvent) {
		if (opts.disabled || st || drag.id || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
		const touch = e.pointerType === "touch";
		st = { pid: e.pointerId, touch, x: e.clientX, y: e.clientY, timer: 0, held: false };
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
		const from = { x: st.x, y: st.y };
		if (active) {
			st.x = e.clientX;
			st.y = e.clientY;
			drag.move(e.clientX, e.clientY);
			return;
		}
		if (Math.hypot(e.clientX - from.x, e.clientY - from.y) <= (st.touch ? SLOP_TOUCH : SLOP_MOUSE)) return;
		if (st.touch && !st.held) return cleanup(); // moved before the hold was up: the user is scrolling
		st.x = e.clientX;
		st.y = e.clientY;
		activate();
	}
	function up(e: PointerEvent) {
		if (!st || e.pointerId !== st.pid) return;
		if (active) drag.end(true);
		// the click that follows letting go (or the long press that opened the menu) is not a click on the row
		if (active || st.held) swallowClick();
		cleanup();
	}
	function cancel(e: PointerEvent) {
		if (!st || e.pointerId !== st.pid) return;
		if (active) drag.end(false);
		cleanup();
	}
	/** Once picked up (or held for the menu, so moving on can still pick it up), the finger moves the session, not the page. */
	function block(e: TouchEvent) {
		if ((active || st?.held) && e.cancelable) e.preventDefault();
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
	const ctx = (e: MouseEvent) => !opts.disabled && contextAt(e, node, opts.menu);

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
