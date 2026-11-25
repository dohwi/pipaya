/**
 * Desktop edge-drag resize and collapse/expand controller shared by the left sidebar and right extension dock.
 * Dragging past the fold threshold snaps immediately to the collapsed state; dragging back out past the unfold
 * threshold (with hysteresis) snaps immediately open; a plain click toggles collapsed without changing width.
 */
import { released } from "../pointer";
import { SIDEBAR_W } from "../sidebar.svelte";

/** Dragged this far past the narrowest width, the panel snaps shut immediately. */
export const FOLD_PAST = 80;
/** Extra travel past `foldAt` required to reopen during the same drag, preventing jitter on the threshold. */
export const UNFOLD_HYSTERESIS = 30;
/** Pointer travel below this (in px) counts as a click to toggle collapsed rather than a drag. */
export const CLICK_SLOP = 4;
/** Width of the collapsed left rail (`--rail-w` in app.css). */
export const RAIL_W = 56;

export interface EdgeResizeTarget {
  isCollapsed(): boolean;
  setCollapsed(collapsed: boolean, persist?: boolean): void;
  shownWidth(): number;
  setWidth(width: number, persist?: boolean): void;
}

export interface EdgeResizeOptions {
  side: "left" | "right";
  collapsedWidth: number;
  minWidth: number;
  maxWidth: number | (() => number);
  foldPast?: number;
  hysteresis?: number;
}

export class EdgeResizeController {
  resizing = $state(false);
  /** True while dragging an open panel below `minWidth` and approaching the snap-to-fold threshold. */
  foldingPreview = $state(false);

  private startX = 0;
  private startW = 0;
  private restoreW = 0;
  private startCollapsed = false;
  private moved = false;

  constructor(
    private readonly target: EdgeResizeTarget,
    private readonly opts: EdgeResizeOptions,
  ) {}

  private get foldAt(): number {
    return this.opts.minWidth - (this.opts.foldPast ?? FOLD_PAST);
  }

  private get unfoldAt(): number {
    return this.foldAt + (this.opts.hysteresis ?? UNFOLD_HYSTERESIS);
  }

  private get maxWidth(): number {
    return typeof this.opts.maxWidth === "function" ? this.opts.maxWidth() : this.opts.maxWidth;
  }

  down = (e: PointerEvent) => {
    if (e.button && e.button !== 0) return;
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    this.startX = e.clientX;
    this.startCollapsed = this.target.isCollapsed();
    this.restoreW = this.target.shownWidth();
    this.startW = this.startCollapsed ? this.opts.collapsedWidth : this.restoreW;
    this.moved = false;
    this.resizing = true;
    this.foldingPreview = false;
    if (typeof document !== "undefined" && document.body?.style) document.body.style.userSelect = "none";
  };

  move = (e: PointerEvent) => {
    if (this.resizing && released(e)) {
      this.up();
      return;
    }
    if (!this.resizing) return;
    const dx = e.clientX - this.startX;
    if (!this.moved && Math.abs(dx) < CLICK_SLOP) return;
    this.moved = true;
    const want = this.opts.side === "left" ? this.startW + dx : this.startW - dx;
    const maxW = this.maxWidth;

    if (!this.target.isCollapsed()) {
      if (want < this.foldAt) {
        this.foldingPreview = false;
        this.target.setCollapsed(true, false);
      } else {
        this.foldingPreview = want < this.opts.minWidth;
        this.target.setWidth(Math.min(maxW, Math.max(this.opts.minWidth, want)), false);
      }
      return;
    }

    this.foldingPreview = false;
    if (want >= this.unfoldAt) {
      this.target.setCollapsed(false, false);
      this.target.setWidth(Math.min(maxW, Math.max(this.opts.minWidth, want)), false);
    }
  };

  up = () => {
    if (!this.resizing) return;
    this.resizing = false;
    this.foldingPreview = false;
    if (typeof document !== "undefined" && document.body?.style) document.body.style.userSelect = "";

    if (!this.moved) {
      this.target.setCollapsed(!this.startCollapsed, true);
      return;
    }

    if (this.target.isCollapsed()) {
      // Preserve the pre-drag open width so unfolding later restores it instead of snapping to minWidth.
      this.target.setWidth(this.restoreW, true);
      this.target.setCollapsed(true, true);
      return;
    }

    this.target.setWidth(this.target.shownWidth(), true);
    this.target.setCollapsed(false, true);
  };

  key = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.target.setCollapsed(!this.target.isCollapsed(), true);
      return;
    }
    const maxW = this.maxWidth;
    if (e.key === "Home" || e.key === "End") {
      if (this.target.isCollapsed()) return;
      e.preventDefault();
      this.target.setWidth(e.key === "Home" ? this.opts.minWidth : maxW, true);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const grow = (this.opts.side === "left" && e.key === "ArrowRight") || (this.opts.side === "right" && e.key === "ArrowLeft");
    if (this.target.isCollapsed()) {
      if (grow) this.target.setCollapsed(false, true);
      return;
    }
    const step = (e.shiftKey ? 64 : 16) * (grow ? 1 : -1);
    this.target.setWidth(Math.min(maxW, Math.max(this.opts.minWidth, this.target.shownWidth() + step)), true);
  };
}

export class SidebarResizeController extends EdgeResizeController {
  constructor(target: EdgeResizeTarget) {
    super(target, {
      side: "left",
      collapsedWidth: RAIL_W,
      minWidth: SIDEBAR_W.min,
      maxWidth: SIDEBAR_W.max,
    });
  }
}
