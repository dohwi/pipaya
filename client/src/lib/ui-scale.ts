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

const VIEWPORT_TAIL = "viewport-fit=cover, interactive-widget=resizes-content";

/** Meta viewport for the scale. Below 100% a mobile browser lays the page out wider (device-width / initial-scale), so
 *  media queries and vw/dvh follow the zoom out like a real browser zoom. It never lays out narrower than the screen,
 *  so above 100% the meta stays plain and the page is zoomed with CSS (a phone is already under every breakpoint). */
export function viewportContent(percent: number): string {
  const scale = percent < 100 ? (percent / 100).toFixed(2) : "1";
  return `width=device-width, initial-scale=${scale}, ${VIEWPORT_TAIL}`;
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
  meta?.setAttribute("content", viewportContent(percent));
  if (percent >= 100) return setCssZoom(percent);
  setCssZoom(100);
  // A browser that ignores the viewport meta keeps its width: zoom the page with CSS instead.
  setTimeout(() => {
    if (run !== token) return;
    if (Math.abs(window.innerWidth - deviceWidth() / (percent / 100)) > 2) setCssZoom(percent);
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
