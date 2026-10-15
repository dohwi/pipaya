/**
 * Motion for the client, in the Material profile.
 *
 * The numbers live in CSS (`:root` in app.css: --motion-fast/normal/slow, --ease, --ease-exit) so that one
 * place tunes everything. The Svelte transitions below read those tokens, which keeps JS-driven and
 * CSS-driven motion identical. Rules carried over:
 *  - entrances decelerate over `normal`, exits accelerate away over `fast` and travel less;
 *  - dialogs move + scale, large floating surfaces (menus, pickers) only translate + fade;
 *  - bottom sheets slide on phones;
 *  - colour tokens never transition for theme changes (see `.theme-switching`), only opacity/geometry do;
 *  - `prefers-reduced-motion` collapses every duration to 0.
 */

export type Frame = { opacity: number; y: number; scale: number };

type Token = "fast" | "normal" | "slow";
const FALLBACK: Record<Token, number> = { fast: 180, normal: 360, slow: 460 };

/** Entrances are bigger than exits (Material: exits are quieter). */
const DIALOG_SHIFT = { in: 18, out: 8 };
const DIALOG_SCALE = { in: 0.94, out: 0.96 };
const EXIT_SHIFT_RATIO = 0.45;
/** Phone sheets leave a little slower than `fast`: they cover most of the screen. */
const SHEET_OUT_FACTOR = 1.35;

export function reduced(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isPhone(): boolean {
	return typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches;
}

/** A duration token in ms; 0 when the user asks for reduced motion. */
export function ms(token: Token): number {
	if (reduced()) return 0;
	if (typeof document === "undefined" || typeof getComputedStyle !== "function" || !document.documentElement) return FALLBACK[token];
	const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--motion-${token}`));
	return Number.isFinite(v) && v >= 0 ? v : FALLBACK[token];
}

/** CSS cubic-bezier() as a function of time → progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	if (x1 === y1 && x2 === y2) return (t) => t;
	const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
	const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
	const X = (t: number) => ((ax * t + bx) * t + cx) * t;
	const Y = (t: number) => ((ay * t + by) * t + cy) * t;
	const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let t = x;
		for (let i = 0; i < 8; i++) {
			const e = X(t) - x;
			if (Math.abs(e) < 1e-6) return Y(t);
			const d = dX(t);
			if (Math.abs(d) < 1e-6) break;
			t -= e / d;
		}
		let lo = 0, hi = 1;
		t = x;
		for (let i = 0; i < 40; i++) {
			const e = X(t) - x;
			if (Math.abs(e) < 1e-6) break;
			if (e > 0) hi = t; else lo = t;
			t = (lo + hi) / 2;
		}
		return Y(t);
	};
}

/** Same curves as --ease / --ease-exit in app.css. */
export const easeEnter = bezier(0.22, 1, 0.36, 1);
export const easeExit = bezier(0.3, 0, 0.8, 0.15);

/** Frame for progress `u` (0 = at rest, 1 = fully away). Dialogs shrink and drop; surfaces only drop. */
export function dialogFrame(u: number, dir: "in" | "out"): Frame {
	return {
		opacity: 1 - u,
		y: u * DIALOG_SHIFT[dir],
		scale: 1 - u * (1 - DIALOG_SCALE[dir]),
	};
}
export function surfaceFrame(u: number, y: number, dir: "in" | "out"): Frame {
	return { opacity: 1 - u, y: u * y * (dir === "out" ? EXIT_SHIFT_RATIO : 1), scale: 1 };
}

const css = (f: Frame, base = 1) =>
	`opacity:${(f.opacity * base).toFixed(3)};transform:translateY(${f.y.toFixed(2)}px) scale(${f.scale.toFixed(4)})`;

const targetOpacity = (node: Element) => {
	const v = typeof getComputedStyle === "function" ? +getComputedStyle(node).opacity : 1;
	return Number.isFinite(v) ? v : 1;
};

/* ---------- fades (scrims, banners, floating buttons) ---------- */
export function fadeIn(node: Element) {
	const o = targetOpacity(node);
	return { duration: ms("normal"), easing: easeEnter, css: (t: number) => `opacity:${(t * o).toFixed(3)}` };
}
export function fadeOut(node: Element) {
	const o = targetOpacity(node);
	return { duration: ms("fast"), easing: easeExit, css: (t: number) => `opacity:${(t * o).toFixed(3)}` };
}

/* ---------- surfaces: menus, pickers, toasts. Translate + fade only, no scale. ---------- */
export function surfaceIn(node: Element, { y = 8 }: { y?: number } = {}) {
	const o = targetOpacity(node);
	return { duration: ms("normal"), easing: easeEnter, css: (_: number, u: number) => css(surfaceFrame(u, y, "in"), o) };
}
export function surfaceOut(node: Element, { y = 8 }: { y?: number } = {}) {
	const o = targetOpacity(node);
	return { duration: ms("fast"), easing: easeExit, css: (_: number, u: number) => css(surfaceFrame(u, y, "out"), o) };
}

/* ---------- panes: the content under a tab strip. Slides a little from the side the new tab is on. ---------- */
export function paneIn(_node: Element, { x = 0 }: { x?: number } = {}) {
	return { duration: ms("normal"), easing: easeEnter, css: (t: number, u: number) => `opacity:${t.toFixed(3)};transform:translateX(${(u * x).toFixed(2)}px)` };
}

/* ---------- collapse: accordion-like open/close of a block ---------- */
import { slide } from "svelte/transition";
export const collapseIn = (node: Element) => slide(node, { duration: ms("normal"), easing: easeEnter });
export const collapseOut = (node: Element) => slide(node, { duration: ms("fast"), easing: easeExit });

/* ---------- modals: centred dialog on desktop, bottom sheet on phones ---------- */
function sheet(node: Element, dir: "in" | "out") {
	const h = (node as HTMLElement).offsetHeight;
	// A sheet pulled down by hand (lib/sheet.ts leaves its offset in --pull) leaves from where the finger let go.
	const from = dir === "out" ? Math.min(h, parseFloat((node as HTMLElement).style.getPropertyValue("--pull")) || 0) : 0;
	return {
		duration: dir === "in" ? ms("normal") : Math.round(ms("fast") * SHEET_OUT_FACTOR),
		easing: dir === "in" ? easeEnter : easeExit,
		css: (_: number, u: number) => `transform:translateY(${(from + u * (h - from)).toFixed(2)}px)`,
	};
}

/** Native <dialog>: its ::backdrop is not part of the element, so flag the exit and let CSS fade it. */
function flagClosing(node: Element) {
	if (typeof HTMLDialogElement !== "undefined" && node instanceof HTMLDialogElement) node.dataset.closing = "";
}

/**
 * Out transition for a component whose root is a native <dialog>: CSS (`dialog[data-closing]`) draws the
 * exit, this only keeps the element mounted until it has finished. Use with `out:holdClosing|global`.
 */
export function holdClosing(node: Element) {
	flagClosing(node);
	return { duration: ms("fast"), tick: () => {} };
}

export function modalIn(node: Element) {
	if (isPhone()) return sheet(node, "in");
	return { duration: ms("normal"), easing: easeEnter, css: (_: number, u: number) => css(dialogFrame(u, "in")) };
}
export function modalOut(node: Element) {
	flagClosing(node);
	if (isPhone()) return sheet(node, "out");
	return { duration: ms("fast"), easing: easeExit, css: (_: number, u: number) => css(dialogFrame(u, "out")) };
}

/**
 * Same exit for a dialog that stays mounted (extension panel): flag it, wait for the CSS exit, then close.
 * Returns a cancel function; opening again before it finishes keeps the dialog open.
 */
export function closeAnimated(dialog: HTMLDialogElement): () => void {
	const wait = ms("fast");
	if (wait === 0 || !dialog.open) {
		dialog.close();
		return () => {};
	}
	dialog.dataset.closing = "";
	const timer = setTimeout(() => {
		if (!("closing" in dialog.dataset)) return;
		delete dialog.dataset.closing;
		dialog.close();
	}, wait + 20);
	return () => {
		clearTimeout(timer);
		delete dialog.dataset.closing;
	};
}

/* ---------- lists: rows added, removed or reordered in a keyed {#each} ---------- */
import { flip } from "svelte/animate";
/**
 * `animate:reflow` on the direct child of a keyed {#each}: the rows that stay slide to their new place instead of
 * jumping when one is added or removed. Pair with `in:rowIn out:rowOut` on the same element.
 */
export function reflow(node: Element, rects: { from: DOMRect; to: DOMRect }) {
	return flip(node, rects, { duration: ms("normal"), easing: easeEnter });
}
/** A row joining a list: opens its height and fades in. */
export const rowIn = (node: Element) => {
	const s = slide(node, { duration: ms("normal"), easing: easeEnter });
	return { ...s, css: (t: number, u: number) => `${s.css!(t, u)};opacity:${t.toFixed(3)}` };
};
/** A row leaving a list: fades while its height closes. */
export const rowOut = (node: Element) => {
	const s = slide(node, { duration: ms("fast"), easing: easeExit });
	return { ...s, css: (t: number, u: number) => `${s.css!(t, u)};opacity:${t.toFixed(3)}` };
};
/** A chip leaving a horizontal strip: shrinks in place (the neighbours `reflow` into the gap). */
export const chipOut = (node: Element) => ({
	duration: ms("fast"),
	easing: easeExit,
	css: (t: number) => `opacity:${t.toFixed(3)};transform:scale(${(0.85 + 0.15 * t).toFixed(4)})`,
});
export const chipIn = (node: Element) => ({
	duration: ms("normal"),
	easing: easeEnter,
	css: (t: number) => `opacity:${t.toFixed(3)};transform:scale(${(0.85 + 0.15 * t).toFixed(4)})`,
});
