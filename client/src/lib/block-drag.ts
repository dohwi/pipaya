/**
 * Reordering sidebar blocks (a directory, a group) by dragging their header, for mouse and touch alike:
 * mouse drags after a few pixels, touch after a long press (so a swipe still scrolls the list); Esc cancels.
 * The drop slot is the block of the same kind under the pointer (`[data-block="<kind>:<key>"]` on the same server),
 * before or after it by which half the pointer is in. Near the list's edges the list scrolls.
 * The component draws the state it is given through `set` and applies the move in `move`.
 */
export interface DirSrc {
	kind: "dir" | "group";
	serverId: string;
	path: string;
	paths: string[];
	disabled: boolean;
}
export interface BlockDragHost {
	/** what is being carried (`kind:key`) and where it would land; both null when nothing is */
	set(drag: string | null, drop: { id: string; after: boolean } | null): void;
	get(): { id: string; after: boolean } | null;
	key(kind: "dir" | "group", key: string): string;
	move(o: DirSrc, target: string, after: boolean): void;
}

export function blockDrag(h: BlockDragHost) {
	return function dirSource(node: HTMLElement, initial: DirSrc) {
		let o = initial;
		let st: { pid: number; touch: boolean; x: number; y: number; timer: number } | null = null;
		let active = false;
		const at = (x: number, y: number) => {
			const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-block]");
			if (!el || el.dataset.server !== o.serverId || !el.dataset.block!.startsWith(`${o.kind}:`)) return null;
			const r = el.getBoundingClientRect();
			return { id: el.dataset.block!, after: y > r.top + r.height / 2 };
		};
		const activate = () => {
			if (!st || active) return;
			active = true;
			clearTimeout(st.timer);
			navigator.vibrate?.(12);
			h.set(h.key(o.kind, o.path), null);
			document.documentElement.classList.add("dnd");
		};
		function down(e: PointerEvent) {
			if (o.disabled || st || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || (e.target as Element).closest(".dirnew, .more, input")) return;
			st = { pid: e.pointerId, touch: e.pointerType === "touch", x: e.clientX, y: e.clientY, timer: 0 };
			if (st.touch) st.timer = window.setTimeout(activate, 380);
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("touchmove", block, { passive: false });
			window.addEventListener("keydown", key);
		}
		function move(e: PointerEvent) {
			if (!st || e.pointerId !== st.pid) return;
			if (!active) {
				if (Math.hypot(e.clientX - st.x, e.clientY - st.y) <= (st.touch ? 10 : 5)) return;
				if (st.touch) return cleanup(); // scrolling, not dragging
				activate();
			}
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
				if (d) h.move(o, d.id.slice(o.kind.length + 1), d.after);
				const stop = (ev: Event) => (ev.stopPropagation(), ev.preventDefault());
				window.addEventListener("click", stop, { capture: true, once: true });
				setTimeout(() => window.removeEventListener("click", stop, true), 120);
			}
			cleanup();
		}
		function cancel(e: PointerEvent) {
			if (st && e.pointerId === st.pid) cleanup();
		}
		function block(e: TouchEvent) {
			if (active && e.cancelable) e.preventDefault();
		}
		function key(e: KeyboardEvent) {
			if (e.key === "Escape" && active) cleanup();
		}
		function cleanup() {
			if (st) clearTimeout(st.timer);
			if (active) document.documentElement.classList.remove("dnd");
			st = null;
			active = false;
			h.set(null, null);
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("touchmove", block);
			window.removeEventListener("keydown", key);
		}
		node.addEventListener("pointerdown", down);
		return {
			update: (next: DirSrc) => (o = next),
			destroy() {
				node.removeEventListener("pointerdown", down);
				cleanup();
			},
		};
	};
}
