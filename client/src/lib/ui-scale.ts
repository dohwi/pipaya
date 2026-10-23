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

const BASE_VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";

/** Meta viewport that makes the layout viewport `percent`% narrower, so media queries and vw/dvh follow the zoom like a real browser zoom. */
export function viewportContent(deviceWidth: number, percent: number): string {
  if (percent === 100) return BASE_VIEWPORT;
  const w = Math.round((deviceWidth * 100) / percent);
  return `width=${w}, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`;
}

/** Width of the screen in CSS px at 100%, for the current orientation. */
function deviceWidth(): number {
  const a = Math.min(screen.width, screen.height);
  const b = Math.max(screen.width, screen.height);
  return matchMedia("(orientation: landscape)").matches ? b : a;
}

function setCssZoom(percent: number) {
  const root = document.documentElement.style;
  if (percent === 100) {
    root.removeProperty("zoom");
    root.removeProperty("--ui-zoom");
  } else {
    root.setProperty("zoom", String(percent / 100));
    root.setProperty("--ui-zoom", String(percent / 100));
  }
}

let current = 100;
let token = 0;

function applyPageScale(percent: number) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const run = ++token;
  setCssZoom(100);
  meta?.setAttribute("content", viewportContent(deviceWidth(), percent));
  if (percent === 100) return;
  // Browsers that ignore the viewport meta (desktop, some webviews) keep their width: zoom the page with CSS instead,
  // and let the --vw / --dvh variables in app.css cancel the zoom out of viewport units.
  setTimeout(() => {
    if (run !== token) return;
    const want = deviceWidth() / (percent / 100);
    if (Math.abs(window.innerWidth - want) > 2) setCssZoom(percent);
  }, 150);
}

export function applyUiScale(percent: number) {
  current = percent;
  if (desktop()) {
    document.documentElement.style.removeProperty("zoom");
    document.documentElement.style.removeProperty("--ui-zoom");
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(percent / 100)).catch(() => {});
  } else applyPageScale(percent);
}

if (typeof matchMedia === "function") {
  // the width the meta asks for depends on the orientation
  matchMedia("(orientation: landscape)").addEventListener("change", () => {
    if (!desktop() && current !== 100) applyPageScale(current);
  });
}
