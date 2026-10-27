/** Geometry of a floating extension window: where it starts, how it is kept on screen, how the keyboard moves it. */
export interface Box { x: number; y: number; w: number; h: number; placed: number }

export const MARGIN = 12;
export const KEY_STEP = 16;
export const MIN_W = 200;
export const MIN_H = 120;

/** Keep a window inside the viewport and no smaller than it can usefully be. */
export function clampBox(b: Box, vw: number, vh: number): Box {
  const w = Math.max(MIN_W, Math.min(b.w, vw - 2 * MARGIN));
  const h = Math.max(MIN_H, Math.min(b.h, vh - 2 * MARGIN));
  return { ...b, w, h, x: Math.min(Math.max(MARGIN, b.x), vw - w - MARGIN), y: Math.min(Math.max(MARGIN, b.y), vh - h - MARGIN) };
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };

/**
 * The box after an arrow key, or null when the key is not for this handle. Plain arrows move a window, Shift+arrows resize it;
 * `mode` is the handle that has focus, so the title bar never resizes and the corner never moves.
 */
export function nudgeBox(from: Box, key: string, mods: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }, mode: "move" | "size"): Box | null {
  const d = ARROWS[key];
  if (!d || mods.alt || mods.ctrl || mods.meta || (mode === "size") !== mods.shift) return null;
  return mode === "move" ? { ...from, x: from.x + d[0], y: from.y + d[1] } : { ...from, w: from.w + d[0], h: from.h + d[1] };
}
