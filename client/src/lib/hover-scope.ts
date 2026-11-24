/**
 * Reliable mouse hover state inside a container (`data-hovered`), replacing native CSS `:hover` where
 * browsers/WebViews (notably WKWebView and Chromium across portaled overlays, transitions, DOM removals,
 * or window blur) can leave `:hover` stuck after the pointer moves elsewhere.
 *
 * Only real mouse pointers set `data-hovered` (touch/pen clear it). Any mouse move outside `node` clears
 * immediately; DOM mutations inside `node` or direct-child overlays on `document.body`, scrolls, resizes,
 * blur, visibility loss, and document exit reconcile against `elementFromPoint` so a disappearing overlay
 * or shifting row never strands a hover state behind.
 */

export interface HoverPoint {
	x: number;
	y: number;
}

const elementOf = (raw: EventTarget | null): Element | null => {
	if (!raw || typeof raw !== "object" || !("nodeType" in raw)) return null;
	const n = raw as Node;
	return n.nodeType === 1 ? (n as Element) : n.parentElement;
};

/**
 * `use:hoverScope={selector}`: marks the ancestor chain inside `node` matching `selector` with `data-hovered`
 * while the real mouse pointer is over it, and clears it the moment the pointer leaves `node`, switches away
 * from mouse input, or the surface/overlay underneath changes.
 */
export function hoverScope(node: HTMLElement, initial: string) {
	const doc = node.ownerDocument;
	const win = doc.defaultView;
	if (!win) return {};

	let selector = initial;
	let active = new Set<Element>();
	let last: HoverPoint | null = null;
	let raf = 0;

	const isInteractive = () => node.isConnected && !node.closest("[inert]");

	function apply(target: Element | null) {
		const next = new Set<Element>();
		if (target && isInteractive() && node.contains(target)) {
			let cur: Element | null = target;
			while (cur && cur !== node) {
				if (cur.matches(selector)) next.add(cur);
				cur = cur.parentElement;
			}
		}
		if (next.size === active.size) {
			let same = true;
			for (const el of next) {
				if (!active.has(el)) {
					same = false;
					break;
				}
			}
			if (same) return;
		}
		for (const el of active) {
			if (!next.has(el)) el.removeAttribute("data-hovered");
		}
		for (const el of next) {
			if (!active.has(el)) el.setAttribute("data-hovered", "");
		}
		active = next;
	}

	function clear(dropPointer = false) {
		if (raf) {
			win!.cancelAnimationFrame(raf);
			raf = 0;
		}
		if (dropPointer) last = null;
		apply(null);
	}

	function inBounds(pt: HoverPoint): boolean {
		const r = node.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
	}

	function reconcile() {
		raf = 0;
		if (!last || doc.hidden || !isInteractive()) {
			apply(null);
			return;
		}
		if (active.size === 0 && !inBounds(last)) return;
		if (typeof doc.elementFromPoint !== "function") {
			apply(null);
			return;
		}
		const hit = doc.elementFromPoint(last.x, last.y);
		apply(hit && node.contains(hit) ? hit : null);
	}

	function scheduleReconcile() {
		if (raf || (active.size === 0 && !last)) return;
		raf = win!.requestAnimationFrame(reconcile);
	}

	const onPointer = (e: PointerEvent) => {
		if (e.pointerType !== "mouse") {
			clear(true);
			return;
		}
		last = { x: e.clientX, y: e.clientY };
		const t = elementOf(e.target);
		apply(t && node.contains(t) ? t : null);
	};

	const onNodeLeave = (e: PointerEvent) => {
		if (e.pointerType === "mouse") apply(null);
	};

	const onDocLeave = () => clear(true);
	const onBlur = () => clear(true);
	const onCancel = () => clear(true);
	const onVisibility = () => {
		if (doc.hidden) clear(true);
	};
	const onScroll = () => scheduleReconcile();
	const onResize = () => scheduleReconcile();

	win.addEventListener("pointermove", onPointer, { capture: true, passive: true });
	win.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
	win.addEventListener("pointercancel", onCancel, { capture: true, passive: true });
	win.addEventListener("blur", onBlur);
	win.addEventListener("resize", onResize, { passive: true });
	doc.addEventListener("visibilitychange", onVisibility);
	doc.documentElement?.addEventListener("pointerleave", onDocLeave);
	doc.documentElement?.addEventListener("mouseleave", onDocLeave);
	node.addEventListener("pointerleave", onNodeLeave);
	node.addEventListener("scroll", onScroll, { capture: true, passive: true });

	const hasElementChange = (records: MutationRecord[]) => {
		for (const r of records) {
			for (const n of r.addedNodes) if (n.nodeType === 1) return true;
			for (const n of r.removedNodes) if (n.nodeType === 1) return true;
		}
		return false;
	};

	const MO = win.MutationObserver;
	const sideMo = typeof MO === "undefined" ? null : new MO((records) => hasElementChange(records) && scheduleReconcile());
	sideMo?.observe(node, { childList: true, subtree: true });

	// Watch direct children of <body> so a portaled menu/modal/toast appearing or disappearing reconciles hover.
	const bodyMo = typeof MO === "undefined" || !doc.body ? null : new MO((records) => hasElementChange(records) && scheduleReconcile());
	bodyMo?.observe(doc.body, { childList: true });

	// Watch the enclosing wrapper (e.g. App.svelte `.side`) for `inert` / collapse class toggles.
	const host = node.parentElement?.closest<HTMLElement>(".side") ?? node.parentElement;
	const hostMo =
		typeof MO === "undefined" || !host
			? null
			: new MO(() => {
					if (host.hasAttribute("inert") || host.classList.contains("collapsed")) clear();
					else scheduleReconcile();
				});
	if (hostMo && host) hostMo.observe(host, { attributes: true, attributeFilter: ["inert", "class"] });

	return {
		update(next: string) {
			selector = next;
			scheduleReconcile();
		},
		destroy() {
			clear(true);
			sideMo?.disconnect();
			bodyMo?.disconnect();
			hostMo?.disconnect();
			win.removeEventListener("pointermove", onPointer, { capture: true });
			win.removeEventListener("pointerdown", onPointer, { capture: true });
			win.removeEventListener("pointercancel", onCancel, { capture: true });
			win.removeEventListener("blur", onBlur);
			win.removeEventListener("resize", onResize);
			doc.removeEventListener("visibilitychange", onVisibility);
			doc.documentElement?.removeEventListener("pointerleave", onDocLeave);
			doc.documentElement?.removeEventListener("mouseleave", onDocLeave);
			node.removeEventListener("pointerleave", onNodeLeave);
			node.removeEventListener("scroll", onScroll, { capture: true });
		},
	};
}
