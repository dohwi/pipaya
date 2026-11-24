/**
 * Mobile/narrow-screen horizontal swipe gesture controller for the sidebar drawer.
 * Extracted from `App.svelte` so touch physics and scroll/selection guards live outside the root component.
 */

// A swipe starting on these keeps its own meaning (typing, selecting, dragging, canvas panning).
// The 24px screen edge still opens the drawer.
const NO_SWIPE =
  "input, textarea, select, [contenteditable], [role=separator], [role=slider], [draggable=true], .grip, [data-own-swipe]";
const MODAL = 'dialog[open], [role="dialog"], [role="alertdialog"]';

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
  isOpen(): boolean;
  setOpen(open: boolean): void;
  isDraggingItem(): boolean;
  getDrawerWidth(): number;
}

export class DrawerSwipeController {
  /** Drawer's visible width in px while dragging, or null when idle. */
  swipe = $state<number | null>(null);
  drawerW = $state(320);

  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastT = 0;
  private vx = 0;
  private tracking = false;
  private locked = false;

  constructor(private readonly hooks: DrawerSwipeHooks) {}

  start = (e: TouchEvent) => {
    this.tracking = false;
    this.locked = false;
    this.swipe = null;
    if (e.touches.length !== 1 || !this.hooks.isNarrow()) return;
    if (typeof document !== "undefined" && typeof document.querySelector === "function" && document.querySelector(MODAL)) return;
    const touch = e.touches[0];
    if (!touch) return;
    this.startX = this.lastX = touch.clientX;
    this.startY = touch.clientY;
    this.lastT = e.timeStamp;
    this.vx = 0;
    if (!this.hooks.isOpen() && touch.clientX >= 24) {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(NO_SWIPE) || scrollsSideways(el)) return;
      const sel = typeof getSelection === "function" ? getSelection() : null;
      if (sel && !sel.isCollapsed && sel.rangeCount && el && sel.getRangeAt(0).intersectsNode(el)) return;
    }
    this.drawerW = this.hooks.getDrawerWidth() || 320;
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
        this.cancel();
        return;
      }
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (this.hooks.isOpen() ? dx > 0 : dx < 0) {
        this.cancel();
        return;
      }
      this.locked = true;
    }
    const dt = e.timeStamp - this.lastT;
    if (dt > 0) this.vx = 0.6 * this.vx + 0.4 * ((touch.clientX - this.lastX) / dt);
    this.lastX = touch.clientX;
    this.lastT = e.timeStamp;
    this.swipe = Math.max(0, Math.min(this.drawerW, (this.hooks.isOpen() ? this.drawerW : 0) + dx));
  };

  end = () => {
    if (!this.tracking || !this.locked || this.swipe === null) {
      this.cancel();
      return;
    }
    const open = this.swipe / this.drawerW > 0.35 ? this.vx > -0.35 : this.vx > 0.35;
    this.hooks.setOpen(open);
    this.cancel();
  };

  cancel = () => {
    this.tracking = false;
    this.locked = false;
    this.swipe = null;
  };
}
