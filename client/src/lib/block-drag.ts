/**
 * Reordering or merging sidebar blocks (a directory, a group, a server) by dragging their header, for mouse and touch
 * alike: mouse drags after a few pixels, touch after a long press (so a swipe still scrolls the list); Esc cancels.
 * The host can supply `resolve` to decide the drop target and placement (`before` / `after` / `over`, e.g. merging
 * folders into a project); otherwise it picks the same-kind block under the pointer (`before` / `after` by half).
 * Near the list's edges the list scrolls. The component draws the state it is given through `set` and applies the
 * result in `move`. With a `menu`, a right click opens it, and so does a touch hold once the finger lifts (moving on
 * from the hold drags the block instead).
 */
import { createDragGhost, type DragGhost } from "./drag-ghost";
import type { BlockDrop } from "./drag-marks.svelte";
import { released } from "./pointer";
import { buzz, contextAt, swallowClick, type MenuOpener } from "./press-menu";

export interface DirSrc {
	kind: "dir" | "group" | "server";
	serverId: string;
	path: string;
	paths: string[];
	disabled: boolean;
	/** Context menu (right click, long press); works even when the block cannot be dragged */
	menu?: MenuOpener;
}
export interface BlockDragHost {
	/** what is being carried (`kind:key`) and where it would land; both null when nothing is */
	set(drag: string | null, drop: BlockDrop | null): void;
	get(): BlockDrop | null;
	key(kind: "dir" | "group" | "server", key: string): string;
	/** Optional custom hit-test & drop-zone resolver; returning `undefined` falls back to same-kind 50/50 before/after. */
	resolve?(o: DirSrc, x: number, y: number): BlockDrop | null | undefined;
	move(o: DirSrc, drop: BlockDrop): void;
}

export function blockDrag(h: BlockDragHost) {
	return function dirSource(node: HTMLElement, initial: DirSrc) {
		let o = initial;
		let st: { pid: number; touch: boolean; x: number; y: number; timer: number; held: boolean } | null = null;
		let active = false;
		let ghost: DragGhost | null = null;
		const at = (x: number, y: number): BlockDrop | null => {
			if (h.resolve) {
				const resolved = h.resolve(o, x, y);
				if (resolved !== undefined) return resolved;
			}
			const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[data-block^="${o.kind}:"]`);
			if (!el || el.dataset.server !== o.serverId) return null; // a server block carries no server of its own: serverId is ""
			const r = el.getBoundingClientRect();
			return { id: el.dataset.block!, place: y > r.top + r.height / 2 ? "after" : "before" };
		};
		const activate = (x: number, y: number) => {
			if (!st || active) return;
			const nextGhost = createDragGhost(node, x, y, st.touch, { x: st.x, y: st.y });
			active = true;
			clearTimeout(st.timer);
			if (!st.held) buzz();
			ghost = nextGhost;
			h.set(h.key(o.kind, o.path), null);
			document.documentElement.classList.add("dnd");
		};
		const hold = () => {
			if (!st) return;
			if (!o.menu) return activate(st.x, st.y);
			st.held = true;
			buzz();
		};
		function down(e: PointerEvent) {
			if ((o.disabled && !o.menu) || st || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || (e.target as Element).closest(".dirnew, .more, input")) return;
			st = { pid: e.pointerId, touch: e.pointerType === "touch", x: e.clientX, y: e.clientY, timer: 0, held: false };
			if (st.touch) st.timer = window.setTimeout(hold, 380);
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("touchmove", block, { passive: false });
			window.addEventListener("contextmenu", nomenu);
			window.addEventListener("keydown", key);
		}
		function move(e: PointerEvent) {
			if (!st || e.pointerId !== st.pid) return;
			if (released(e)) return cleanup(); // let go where no pointerup reached us
			if (!active) {
				if (Math.hypot(e.clientX - st.x, e.clientY - st.y) <= (st.touch ? 10 : 5)) return;
				if ((st.touch && !st.held) || o.disabled) return cleanup(); // scrolling, not dragging (or nothing to drag)
				activate(e.clientX, e.clientY);
			}
			ghost?.move(e.clientX, e.clientY);
			h.set(h.key(o.kind, o.path), at(e.clientX, e.clientY));
			// near the edge of the list: scroll it
			const list = node.closest<HTMLElement>(".list");
			if (list) {
				const r = list.getBoundingClientRect();
				if (e.clientY < r.top + 40) list.scrollTop -= 12;
				else if (e.clientY > r.bottom - 40) list.scrollTop += 12;
			}
		}
		function up(e: PointerEvent) {
			if (!st || e.pointerId !== st.pid) return;
			if (active) {
				const d = h.get();
				if (d) h.move(o, d);
			}
			if (active || st.held) swallowClick();
			// held and let go in place: the menu opens now, where the finger was
			const menuAt = !active && st.held && o.menu ? { x: st.x, y: st.y } : null;
			cleanup();
			if (menuAt) o.menu?.(menuAt);
		}
		function cancel(e: PointerEvent) {
			if (st && e.pointerId === st.pid) cleanup();
		}
		function block(e: TouchEvent) {
			if ((active || (st?.held && !o.disabled)) && e.cancelable) e.preventDefault();
		}
		/** A long press must not also raise the browser's own menu. */
		function nomenu(e: Event) {
			if (st?.touch) e.preventDefault();
		}
		function key(e: KeyboardEvent) {
			if (e.key === "Escape" && active) cleanup();
		}
		function cleanup() {
			if (st) clearTimeout(st.timer);
			if (active) document.documentElement.classList.remove("dnd");
			ghost?.remove();
			ghost = null;
			st = null;
			active = false;
			h.set(null, null);
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("touchmove", block);
			window.removeEventListener("contextmenu", nomenu);
			window.removeEventListener("keydown", key);
		}
		const ctx = (e: MouseEvent) => !(e.target as Element).closest(".dirnew, .more, input") && contextAt(e, node, o.menu);
		node.addEventListener("pointerdown", down);
		node.addEventListener("contextmenu", ctx);
		return {
			update: (next: DirSrc) => (o = next),
			destroy() {
				node.removeEventListener("pointerdown", down);
				node.removeEventListener("contextmenu", ctx);
				cleanup();
			},
		};
	};
}
