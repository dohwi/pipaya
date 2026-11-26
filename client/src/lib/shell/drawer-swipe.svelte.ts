/**
 * Mobile/narrow-screen horizontal swipe gesture controller for both side drawers
 * (left: sessions sidebar, right: workspace file tree).
 * Extracted from `App.svelte` so touch physics and scroll/selection guards live outside the root component.
 */

export type DrawerSide = "left" | "right";

// A swipe starting on these keeps its own meaning (typing, selecting, dragging, formulas, canvas panning).
// The 24px screen edges still open their corresponding drawer.
const NO_SWIPE =
	"input, textarea, select, [contenteditable], [role=separator], [role=slider], [draggable=true], .grip, .katex-display, [data-own-swipe]";
const MODAL = 'dialog[open], [role="dialog"], [role="alertdialog"]';
const EDGE_ZONE_PX = 24;
const SCROLL_COOLDOWN_MS = 150;
const FLICK_MIN_PX = 40;
const FLICK_VEL = 0.35;

export function scrollsSideways(el: Element | null): boolean {
	for (; el && el !== document.body; el = el.parentElement) {
		if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) {
			return true;
		}
	}
	return false;
}

export interface DrawerSwipeHooks {
	isNarrow(): boolean;
	isOpen(side: DrawerSide): boolean;
	setOpen(side: DrawerSide, open: boolean): void;
	/** Whether a closed drawer on `side` can be swiped open right now (defaults to true). */
	canOpen?(side: DrawerSide): boolean;
	/** Whether a full-screen narrow overlay (e.g. extension dock) should block opening drawer swipes. */
	isBlocked?(): boolean;
	isDraggingItem(): boolean;
	getDrawerWidth(side: DrawerSide): number;
	/** Viewport width for symmetric edge-zone checks (defaults to `window.innerWidth`). */
	getViewportWidth?(): number;
}

export class DrawerSwipeController {
	/** Which drawer is currently being dragged, or null when idle. */
	side = $state<DrawerSide | null>(null);
	/** Active drawer's visible width in px while dragging (`0..drawerW`), or null when idle. */
	swipe = $state<number | null>(null);
	drawerW = $state(320);

	private startX = 0;
	private startY = 0;
	private lastX = 0;
	private lastT = 0;
	private vx = 0;
	private tracking = false;
	private locked = false;
	private wasOpen = false;
	private activeSide: DrawerSide | null = null;
	/** When touch started on a guarded element inside a 24px screen edge, only that side's drawer may open. */
	private edgeOnly: DrawerSide | null = null;
	/** True while tracking a user-initiated vertical scroll / momentum fling (ignores programmatic streaming scroll). */
	private userScrollActive = false;
	private lastScrollAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly hooks: DrawerSwipeHooks) {}

	/** Visible width of the left drawer while dragging it, or null. */
	get leftSwipe(): number | null {
		return this.side === "left" ? this.swipe : null;
	}

	/** Visible width of the right drawer while dragging it, or null. */
	get rightSwipe(): number | null {
		return this.side === "right" ? this.swipe : null;
	}

	/**
	 * Extend the scroll cooldown while momentum from a user vertical swipe continues.
	 * Programmatic scrolls (e.g. streaming auto-follow) are ignored when `userScrollActive` is false.
	 */
	noteScroll = (e?: { timeStamp?: number }) => {
		if (!this.userScrollActive) return;
		const ts = e?.timeStamp;
		const now = typeof ts === "number" && Number.isFinite(ts) ? ts : performance.now();
		if (now - this.lastScrollAt > SCROLL_COOLDOWN_MS * 2) {
			this.userScrollActive = false;
			return;
		}
		this.lastScrollAt = now;
	};

	start = (e: TouchEvent) => {
		this.reset();
		if (e.touches.length !== 1 || !this.hooks.isNarrow()) return;
		if (typeof document !== "undefined" && typeof document.querySelector === "function" && document.querySelector(MODAL)) return;
		const touch = e.touches[0];
		if (!touch) return;

		const openSide: DrawerSide | null = this.hooks.isOpen("left")
			? "left"
			: this.hooks.isOpen("right")
				? "right"
				: null;

		if (openSide === null) {
			if (this.hooks.isBlocked?.()) return;
			const sinceScroll = e.timeStamp - this.lastScrollAt;
			if (this.userScrollActive && sinceScroll >= 0 && sinceScroll < SCROLL_COOLDOWN_MS) return;
			this.userScrollActive = false;

			const el = typeof Element !== "undefined" && e.target instanceof Element ? e.target : null;
			if (this.isGuardedTarget(el)) {
				const vw = this.hooks.getViewportWidth?.() ?? (typeof window !== "undefined" ? window.innerWidth : 0);
				if (touch.clientX < EDGE_ZONE_PX) {
					this.edgeOnly = "left";
				} else if (vw > 0 && touch.clientX > vw - EDGE_ZONE_PX) {
					this.edgeOnly = "right";
				} else {
					return;
				}
			}
		} else {
			this.drawerW = this.hooks.getDrawerWidth(openSide) || 320;
		}

		this.startX = this.lastX = touch.clientX;
		this.startY = touch.clientY;
		this.lastT = e.timeStamp;
		this.vx = 0;
		this.wasOpen = openSide !== null;
		this.activeSide = openSide;
		this.tracking = true;
	};

	move = (e: TouchEvent) => {
		if (!this.tracking) return;
		if (this.hooks.isDraggingItem() || e.touches.length !== 1) {
			this.cancel();
			return;
		}
		const touch = e.touches[0];
		if (!touch) return;
		const dx = touch.clientX - this.startX;
		const dy = touch.clientY - this.startY;

		if (!this.locked) {
			if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
				if (!this.wasOpen) {
					this.userScrollActive = true;
					this.lastScrollAt = e.timeStamp;
				}
				this.cancel();
				return;
			}
			// Opening from anywhere requires a flatter horizontal angle to resist curved vertical thumb scrolls;
			// closing an already-open drawer stays forgiving.
			const minDx = this.wasOpen ? 8 : 12;
			const minSlope = this.wasOpen ? 1.5 : 2;
			if (Math.abs(dx) < minDx || Math.abs(dx) < Math.abs(dy) * minSlope) return;

			if (!this.wasOpen) {
				const targetSide: DrawerSide = dx > 0 ? "left" : "right";
				if (this.edgeOnly && targetSide !== this.edgeOnly) {
					this.cancel();
					return;
				}
				if (this.hooks.canOpen && !this.hooks.canOpen(targetSide)) {
					this.cancel();
					return;
				}
				this.activeSide = targetSide;
				this.drawerW = this.hooks.getDrawerWidth(targetSide) || 320;
			} else if (this.activeSide === "left" ? dx > 0 : dx < 0) {
				this.cancel();
				return;
			}

			this.locked = true;
			this.side = this.activeSide;
		}

		if (!this.activeSide) return;
		const sign = this.activeSide === "left" ? 1 : -1;
		const dt = e.timeStamp - this.lastT;
		if (dt > 0) this.vx = 0.6 * this.vx + 0.4 * (((touch.clientX - this.lastX) * sign) / dt);
		this.lastX = touch.clientX;
		this.lastT = e.timeStamp;
		const base = this.wasOpen ? this.drawerW : 0;
		this.swipe = Math.max(0, Math.min(this.drawerW, base + dx * sign));
	};

	end = () => {
		if (!this.tracking || !this.locked || this.swipe === null || !this.activeSide) {
			this.cancel();
			return;
		}
		const side = this.activeSide;
		const base = this.wasOpen ? this.drawerW : 0;
		const moved = Math.abs(this.swipe - base);
		const ratio = this.swipe / this.drawerW;
		const threshold = this.wasOpen ? 0.65 : 0.35;
		const open =
			ratio > threshold
				? !(moved >= FLICK_MIN_PX && this.vx <= -FLICK_VEL)
				: moved >= FLICK_MIN_PX && this.vx >= FLICK_VEL;
		this.hooks.setOpen(side, open);
		this.cancel();
	};

	cancel = () => {
		this.reset();
	};

	private reset() {
		this.tracking = false;
		this.locked = false;
		this.wasOpen = false;
		this.activeSide = null;
		this.edgeOnly = null;
		this.side = null;
		this.swipe = null;
	}

	private isGuardedTarget(el: Element | null): boolean {
		if (!el) return false;
		if (el.closest(NO_SWIPE) || scrollsSideways(el)) return true;
		const sel = typeof getSelection === "function" ? getSelection() : null;
		return Boolean(sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(el));
	}
}
