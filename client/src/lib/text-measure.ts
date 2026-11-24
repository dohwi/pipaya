/**
 * Fast offscreen text width measurement via Canvas 2D, avoiding DOM mutations and forced synchronous layouts.
 * Falls back to `null` when Canvas 2D is unavailable (SSR, happy-dom tests), so callers can fall back to DOM.
 */

export interface FontSpec {
	/** CSS shorthand `font` string for CanvasRenderingContext2D (e.g. `600 14px Inter, sans-serif`). */
	font: string;
	/** Numeric letter-spacing in px (0 when `normal`). */
	letterSpacing: number;
}

const CACHE_LIMIT = 8_000;
const cache = new Map<string, number>();

let ctx: CanvasRenderingContext2D | null | undefined;
let supportsCtxLetterSpacing = false;
let fontsHooked = false;
const fontListeners = new Set<() => void>();

function getContext(): CanvasRenderingContext2D | null {
	if (ctx !== undefined) return ctx;
	if (typeof document === "undefined") return (ctx = null);
	try {
		const canvas = document.createElement("canvas");
		const c = canvas.getContext("2d");
		ctx = c ?? null;
		if (c && "letterSpacing" in c) supportsCtxLetterSpacing = true;
	} catch {
		ctx = null;
	}
	if (!fontsHooked && typeof document !== "undefined" && document.fonts?.addEventListener) {
		fontsHooked = true;
		document.fonts.addEventListener("loadingdone", () => {
			cache.clear();
			for (const fn of fontListeners) fn();
		});
	}
	return ctx;
}

/** Subscribe to web-font load completions (when cached text widths are invalidated). Returns an unsubscribe function. */
export function onFontsLoaded(fn: () => void): () => void {
	getContext();
	fontListeners.add(fn);
	return () => fontListeners.delete(fn);
}

/** Build a Canvas `FontSpec` from an element's computed style, with an optional weight override. */
export function fontSpecOf(el: Element, weightOverride?: string): FontSpec {
	const cs = getComputedStyle(el);
	const style = cs.fontStyle && cs.fontStyle !== "normal" ? `${cs.fontStyle} ` : "";
	const weight = weightOverride ?? cs.fontWeight ?? "400";
	const size = cs.fontSize || "14px";
	const family = cs.fontFamily || "sans-serif";
	const ls = cs.letterSpacing && cs.letterSpacing !== "normal" ? Number.parseFloat(cs.letterSpacing) || 0 : 0;
	return { font: `${style}${weight} ${size} ${family}`, letterSpacing: ls };
}

/**
 * Measure `text` rendered in `spec`. Returns `null` when Canvas 2D is unavailable.
 * Cached across mounts so reopening a view does not re-measure unchanged text.
 */
export function measureTextWidth(text: string, spec: FontSpec): number | null {
	if (!text) return 0;
	const c = getContext();
	if (!c) return null;
	const key = `${spec.font}\u0000${spec.letterSpacing}\u0000${text}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	if (cache.size >= CACHE_LIMIT) cache.clear();
	c.font = spec.font;
	let w: number;
	if (spec.letterSpacing && supportsCtxLetterSpacing) {
		(c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spec.letterSpacing}px`;
		w = c.measureText(text).width;
		(c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
	} else {
		w = c.measureText(text).width;
		if (spec.letterSpacing && text.length > 1) w += spec.letterSpacing * ([...text].length - 1);
	}
	cache.set(key, w);
	return w;
}

/** Clear the module-level measurement cache (tests). */
export function clearTextMeasureCache(): void {
	cache.clear();
}
