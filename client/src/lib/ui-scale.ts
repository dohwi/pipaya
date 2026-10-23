/** Whole-app zoom. The desktop app zooms its webview; anywhere else the page itself is zoomed with CSS. */
import { isTauri } from "./tauri";

export const MIN_SCALE = 50;
export const MAX_SCALE = 200;
export const SCALE_STEP = 10;

export function clampScale(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 100;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n / SCALE_STEP) * SCALE_STEP));
}

export function stepScale(cur: number, dir: 1 | -1): number {
  return clampScale(cur + dir * SCALE_STEP);
}

const desktop = (): boolean => isTauri() && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export function applyUiScale(percent: number) {
  const factor = percent / 100;
  if (desktop()) {
    document.documentElement.style.removeProperty("zoom");
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(factor)).catch(() => {});
  } else if (percent === 100) document.documentElement.style.removeProperty("zoom");
  else document.documentElement.style.setProperty("zoom", String(factor));
}
