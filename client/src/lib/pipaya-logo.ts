/**
 * The pipaya logo (the papaya-tree mark and the "pipaya" wordmark), drawn so that no extension can change it.
 *
 * Each logo is a host element with a CLOSED shadow root holding plain SVG with literal colours and sizes:
 *  - no selector outside reaches into it (extension styles, a component's `:global()` CSS, `document.querySelector`);
 *  - its own `:host` rule resets every property with `!important`, and an important declaration of the shadow tree
 *    beats any important one outside it, so a rule that does match the host (`.brandrow > *`) cannot hide, move,
 *    resize, tint or transform it;
 *  - it reads no design token (`var(--…)`) and no font: the wordmark is the glyph outlines of JetBrains Mono 600
 *    (logo/build_wordmark.py), so `--mono`, `--font`, `--text` or an `@font-face` with the same name change nothing.
 *  - its colours are the brand's own, in the variant for a dark or a light backdrop, chosen from the colour actually
 *    behind it, so a theme can neither recolour it nor paint the page in its colour to make it vanish.
 * The elements around a brand logo are guarded too: extension rules never match the logo or its frame, and an element
 * that holds one cannot be hidden, faded or transformed (extensions/style.ts).
 *
 * Tones of the mark: `color` two-tone; `solid` and the wordmark in the brand ink; `watermark` the faint mark of the empty
 * screens. `current` takes the colour of where it sits, like an icon (the agent badge paints it in its state colour):
 * it is not the logo there but a model's icon or a status glyph, so it follows the page like every other icon.
 */
import { WORDMARK_PATH, WORDMARK_W } from "./wordmark-path";

const TRUNK = "M51 62H77L86 106H42Z";
const LEAF = "M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z";
const LEAF_K = 1.1;
/** [angle, length] of the five fronds; geometry from logo/build_mark.py */
const FRONDS = [[-100, 0.9], [-50, 1.0], [0, 0.94], [50, 1.0], [100, 0.9]] as const;
const FRUITS = [[55.5, 68], [72.5, 68]] as const;
const R = 10.5;
const KNOCK = 13.7;
export const MARK_VIEWBOX = "15.22 11.44 97.56 97.56";

/**
 * The brand's colours for a dark and for a light backdrop. Mark: logo/build_mark.py (DARK, LIGHT). Ink: the app's text
 * colour (app.css `--text`). Watermark: the empty screens' old `color-mix(--text-faint 35%, --bg)` of the default theme.
 */
export const BRAND = {
	dark: { trunk: "#7a5b44", leaf: "#4a9443", fruit: "#f08a24", ink: "#ededed", watermark: "#424246" },
	light: { trunk: "#5a4130", leaf: "#2f6d2d", fruit: "#f08a24", ink: "#0a0a0b", watermark: "#c8c8cc" },
} as const;
export type MarkTone = "color" | "solid" | "watermark" | "current";
/** Where the wordmark's baseline sits in its 1em box (logo/build_wordmark.py BASELINE), for inline alignment. */
const WORDMARK_BASELINE = 0.86;

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * `:host` locked to the given box. `all: initial !important` resets everything (custom properties are not part of
 * `all`, which is why nothing inside reads one); only what must follow the page is inherited: `visibility` and
 * `pointer-events` (so a hidden or inert layer, like the folded sidebar, hides the logo with it) and, for the `current`
 * mark, `color`.
 */
function hostRule(display: string, w: number, h: number, extra = ""): string {
	return `:host{all:initial!important;display:${display}!important;flex:none!important;box-sizing:content-box!important;` +
		`width:${px(w)}!important;height:${px(h)}!important;visibility:inherit!important;pointer-events:inherit!important;${extra}}` +
		`svg{display:block;width:100%;height:100%;overflow:visible}`;
}

export interface MarkOptions { size: number; tone: MarkTone; dark: boolean }

/** Shadow-root markup of the mark. `dark`: the backdrop is dark. */
export function markMarkup({ size, tone, dark }: MarkOptions): string {
	const c = BRAND[dark ? "dark" : "light"];
	const one = tone === "current" ? "currentColor" : tone === "solid" ? c.ink : tone === "watermark" ? c.watermark : null;
	const [trunk, leaf, fruit] = one ? [one, one, one] : [c.trunk, c.leaf, c.fruit];
	const fronds = FRONDS.map(([a, k]) => `<path d="${LEAF}" transform="translate(64 62) rotate(${a}) scale(${LEAF_K} ${Math.round(LEAF_K * k * 1000) / 1000})"/>`).join("");
	const holes = FRUITS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${KNOCK}" fill="#000"/>`).join("");
	const fruits = FRUITS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${R}" fill="${fruit}"/>`).join("");
	return `<style>${hostRule("block", size, size, tone === "current" ? "color:inherit!important;" : "")}</style>` +
		`<svg viewBox="${MARK_VIEWBOX}" role="img" aria-label="pipaya">` +
		`<defs><mask id="k" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256"><rect x="-64" y="-64" width="256" height="256" fill="#fff"/>${holes}</mask></defs>` +
		`<g mask="url(#k)"><path d="${TRUNK}" fill="${trunk}"/><g fill="${leaf}"><ellipse cx="64" cy="58" rx="6.5" ry="8.5"/>${fronds}</g></g>${fruits}</svg>`;
}

export interface WordmarkOptions { size: number; dark: boolean }

/**
 * Shadow-root markup of the wordmark: `size` px tall (the old text's 1em line box), as wide as the word. On a text line
 * its baseline sits on the line's, like the text it replaces.
 */
export function wordmarkMarkup({ size, dark }: WordmarkOptions): string {
	const w = (size * WORDMARK_W) / 1000;
	return `<style>${hostRule("inline-block", w, size, `vertical-align:${px(-(1 - WORDMARK_BASELINE) * size)}!important;`)}</style>` +
		`<svg viewBox="0 0 ${WORDMARK_W} 1000" role="img" aria-label="pipaya"><path fill="${BRAND[dark ? "dark" : "light"].ink}" d="${WORDMARK_PATH}"/></svg>`;
}

/** Relative luminance (WCAG) of an sRGB colour given as 0-255 channels. */
export function luminance(r: number, g: number, b: number): number {
	const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()` (what a canvas gives back) as [r, g, b, alpha 0-1]; null otherwise. */
export function parseColor(text: string): [number, number, number, number] | null {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(text.trim());
	if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16), hex[4] ? parseInt(hex[4], 16) / 255 : 1];
	const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(text.trim());
	if (!fn) return null;
	const a = fn[4] === undefined ? 1 : fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
	return [parseFloat(fn[1]!), parseFloat(fn[2]!), parseFloat(fn[3]!), a];
}

let canvas: CanvasRenderingContext2D | null | undefined;
/** Any CSS colour a browser computes (`rgb()`, `color(srgb …)`, `oklch()` …) in a form `parseColor` reads. */
function normalize(css: string): string {
	if (canvas === undefined) canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
	if (!canvas) return css;
	canvas.fillStyle = "#00000000";
	canvas.fillStyle = css;
	return String(canvas.fillStyle);
}

/**
 * Whether what is behind `el` is dark: the first ancestor with a mostly opaque background colour decides. Nothing found
 * (or no layout, as in tests): `fallback`.
 */
export function backdropIsDark(el: Element, fallback: boolean): boolean {
	if (typeof getComputedStyle !== "function") return fallback;
	for (let e: Element | null = el.parentElement; e; e = e.parentElement) {
		const c = parseColor(normalize(getComputedStyle(e).backgroundColor));
		if (c && c[3] >= 0.5) return luminance(c[0], c[1], c[2]) < 0.18;
	}
	return fallback;
}

const live = new Map<HTMLElement, () => void>();
const roots = new WeakMap<HTMLElement, ShadowRoot>();
const mountListeners = new Set<() => void>();

/** The brand logos on screen now (not the `current` mark, which is an icon). */
export function brandLogos(): HTMLElement[] {
	return [...live.keys()].filter(h => h.hasAttribute("data-pipaya-logo") && h.isConnected);
}
/** Called after a logo mounts (the extension host checks that no stylesheet covers it). */
export function onLogoMount(fn: () => void): () => void {
	mountListeners.add(fn);
	return () => mountListeners.delete(fn);
}

/**
 * Points of each logo where something else is drawn on top (the element the browser hits there is not the logo).
 * Returns one key per covered logo point, so two layouts can be compared.
 */
export function coveredPoints(logos: readonly HTMLElement[] = brandLogos()): Set<string> {
	const out = new Set<string>();
	if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return out;
	logos.forEach((host, n) => {
		const r = host.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return;
		for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.3, 0.75], [0.7, 0.75]] as const) {
			const x = r.left + r.width * fx, y = r.top + r.height * fy;
			if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
			const top = document.elementFromPoint(x, y);
			if (top !== host) out.add(`${n}:${fx}:${fy}`);
		}
	});
	return out;
}

/** Choose every logo's colours again (a theme or a stylesheet may have changed what is behind them). */
export function repaintLogos() {
	for (const paint of live.values()) paint();
}

/**
 * Attachment that draws `markup(dark)` into the element's closed shadow root, `dark` being whether its backdrop is dark
 * (`fallbackDark()` when that cannot be told). Svelte runs it again when what it reads changes (size, the app's mode).
 */
export function logo(markup: (dark: boolean) => string, fallbackDark: () => boolean) {
	return (host: HTMLElement) => {
		const fallback = fallbackDark();
		let root = roots.get(host);
		if (!root) roots.set(host, (root = host.attachShadow({ mode: "closed" })));
		const shadow = root;
		let last = "";
		const paint = () => {
			const next = markup(backdropIsDark(host, fallback));
			if (next !== last) shadow.innerHTML = last = next;
		};
		paint();
		const fresh = !live.has(host);
		live.set(host, paint);
		if (fresh) queueMicrotask(() => { for (const fn of mountListeners) fn(); });
		return () => {
			live.delete(host);
		};
	};
}
