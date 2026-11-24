/**
 * Desktop sidebar edge-drag resize and keyboard splitter controller.
 * Extracted from `App.svelte` so pointer-capture and fold-threshold physics have a single unit-testable owner.
 */
import { released } from "../pointer";
import { SIDEBAR_W } from "../sidebar.svelte";

/** Dragged this far past the narrowest width, letting go folds the sidebar into the rail (as in an editor). */
export const FOLD_PAST = 80;

export interface SidebarResizeTarget {
  shownWidth(): number;
  setWidth(width: number, persist?: boolean): void;
  toggleCollapsed(): void;
}

export class SidebarResizeController {
  resizing = $state(false);
  foldOnRelease = $state(false);
  private gripFrom = { x: 0, w: 0 };

  constructor(private readonly target: SidebarResizeTarget) {}

  down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    this.gripFrom = { x: e.clientX, w: this.target.shownWidth() };
    this.resizing = true;
    this.foldOnRelease = false;
    if (typeof document !== "undefined" && document.body?.style) document.body.style.userSelect = "none";
  };

  move = (e: PointerEvent) => {
    if (this.resizing && released(e)) {
      this.up();
      return;
    }
    if (!this.resizing) return;
    const want = this.gripFrom.w + e.clientX - this.gripFrom.x;
    this.foldOnRelease = want < SIDEBAR_W.min - FOLD_PAST;
    this.target.setWidth(want, false);
  };

  up = () => {
    if (!this.resizing) return;
    this.resizing = false;
    if (typeof document !== "undefined" && document.body?.style) document.body.style.userSelect = "";
    if (this.foldOnRelease) {
      // Preserve the starting width so unfolding restores it rather than snapping to min.
      this.foldOnRelease = false;
      this.target.setWidth(this.gripFrom.w);
      this.target.toggleCollapsed();
      return;
    }
    this.target.setWidth(this.target.shownWidth());
  };

  key = (e: KeyboardEvent) => {
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.target.setWidth(e.key === "Home" ? SIDEBAR_W.min : SIDEBAR_W.max);
      return;
    }
    const delta = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (!delta) return;
    e.preventDefault();
    this.target.setWidth(this.target.shownWidth() + delta * (e.shiftKey ? 4 : 1));
  };
}
