import { ASSET_REF } from "./schema";
/**
 * An extension stylesheet has to beat the app's own: Svelte scopes every built-in rule (`header.svelte-x`,
 * `.a.svelte-x .b.svelte-x`), which outranks a plain `[data-part="header"]`. So each style rule's selector is placed
 * behind a few `:root`s, which raises its specificity above any scoped rule without `!important`.
 *
 * The same pass keeps every rule off the pipaya logo (lib/pipaya-logo.ts):
 *  - a logo (`[data-pipaya-logo]`), its frame (`[data-logo-frame]`, the row or box the app draws it in) and every
 *    element between the two match no extension rule at all;
 *  - an element that holds a logo further down (the sidebar, the pane, `body`) can be styled, but not with a property
 *    that changes how everything inside it looks (SEE_THROUGH: hiding, fading, filtering, transforming, clipping,
 *    replacing its content), and it gets no `::before` / `::after` (a layer drawn over the logo).
 * A rule that sets such properties is split in two: the rest applies as written, the SEE_THROUGH part only where no
 * logo is inside. Rules at the top level, nested ones and those inside `@media` / `@supports` / `@layer` / `@container`
 * are handled; `@keyframes` and `@font-face` stay as they are.
 */
const BOOST = ":root:root:root:root:root:root";

/** Selectors that already name the root are not raised (`:root { --x: 1 }`, `html`, `body`): they are not inside the app's scoped rules. */
const ROOTISH = /^\s*(?::root|html|body)\b/;

export const LOGO = "[data-pipaya-logo]";
export const LOGO_FRAME = "[data-logo-frame]";
/** No extension rule reaches a logo, its frame, or what lies between the two. */
const OFF_LOGO = `:not(${LOGO_FRAME}, ${LOGO_FRAME} :has(${LOGO}), ${LOGO})`;
/** Elements with no logo inside. */
const NO_LOGO_INSIDE = `:not(:has(${LOGO}))`;
/** Properties that change how everything inside an element looks: not for an element that holds a logo. */
export const SEE_THROUGH = /^(?:display|visibility|opacity|filter|mix-blend-mode|isolation|clip|clip-path|mask(?:-[a-z-]+)?|-webkit-mask(?:-[a-z-]+)?|transform|transform-origin|translate|rotate|scale|zoom|content|content-visibility|writing-mode|direction)$/;
/** A pseudo-element at the end of a selector (`::before`, the old `:after`, `::part(x)` …). */
const PSEUDO = /(::[a-z-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter))\s*$/i;

/** Selectors of a list, split on the top-level commas only (not inside `:is(a, b)` or `[x="a,b"]`). */
export function splitSelectors(text: string): string[] {
	const out: string[] = [];
	let depth = 0, start = 0, quote = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
		if (c === '"' || c === "'") quote = c;
		else if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
	}
	out.push(text.slice(start));
	return out.map(s => s.trim()).filter(Boolean);
}

/** One selector of a list, raised (top level only) and kept off the logo. `seeThrough`: also off elements holding one. */
export function guardSelector(part: string, nested: boolean, seeThrough = false): string {
	const pseudo = PSEUDO.exec(part);
	const base = pseudo ? part.slice(0, pseudo.index).trim() || "*" : part;
	const raise = nested || ROOTISH.test(base) ? "" : `${BOOST} `;
	// a pseudo-element of an element that holds a logo is a layer drawn over it
	const holders = pseudo || seeThrough ? NO_LOGO_INSIDE : "";
	return `${raise}:is(${base})${OFF_LOGO}${holders}${pseudo ? pseudo[1] : ""}`;
}

interface RuleList { cssRules: CSSRuleList; insertRule(rule: string, index?: number): number; deleteRule(index: number): void }

/** Declarations of `style` whose property matches `pick`, as CSS text, removed from `style`. */
function takeOut(style: CSSStyleDeclaration, pick: RegExp): string {
	const taken: string[] = [];
	for (const p of Array.from(style)) {
		if (!pick.test(p)) continue;
		const important = style.getPropertyPriority(p) ? " !important" : "";
		taken.push(`${p}: ${style.getPropertyValue(p)}${important};`);
	}
	for (const d of taken) style.removeProperty(d.slice(0, d.indexOf(":")));
	return taken.join(" ");
}

function guardList(list: RuleList, nested: boolean) {
	// backwards, so rules inserted after the current one are not visited
	for (let i = list.cssRules.length - 1; i >= 0; i--) {
		const rule = list.cssRules[i]!;
		if (rule instanceof CSSStyleRule) {
			const parts = splitSelectors(rule.selectorText);
			const wanted = parts.map(p => guardSelector(p, nested)).join(", ");
			rule.selectorText = wanted;
			// An engine that cannot parse the guarded selector keeps the old one: such a rule must not stay.
			if (rule.selectorText !== wanted && !sameSelector(rule.selectorText, wanted)) { list.deleteRule(i); continue; }
			const plain = parts.filter(p => !PSEUDO.test(p));
			const moved = takeOut(rule.style, SEE_THROUGH);
			if (moved && plain.length) {
				try { list.insertRule(`${plain.map(p => guardSelector(p, nested, true)).join(", ")} { ${moved} }`, i + 1); } catch { /* dropped: it only ever hid things */ }
			}
			if ((rule as unknown as Partial<RuleList>).cssRules?.length) guardList(rule as unknown as RuleList, true);
		} else if (isNestedDeclarations(rule)) {
			const moved = takeOut((rule as unknown as { style: CSSStyleDeclaration }).style, SEE_THROUGH);
			if (moved) try { list.insertRule(`&${NO_LOGO_INSIDE} { ${moved} }`, i + 1); } catch { /* dropped */ }
		} else if (rule instanceof CSSGroupingRule) guardList(rule, nested);
	}
}

/** The browser may write a selector back with other spacing or quotes; compare without those. */
function sameSelector(a: string, b: string): boolean {
	const norm = (s: string) => s.replace(/\s+/g, "").replace(/'/g, '"');
	return norm(a) === norm(b);
}

function isNestedDeclarations(rule: CSSRule): boolean {
	return typeof CSSNestedDeclarations !== "undefined" && rule instanceof CSSNestedDeclarations;
}

/** Raise every rule of an extension stylesheet above the app's own and keep it off the pipaya logo (see above). */
export function prepareSheet(sheet: CSSStyleSheet | null | undefined): void {
	if (!sheet) return;
	guardList(sheet, false);
}

/**
 * Put a package's design files into its stylesheet: every `asset("name")` becomes `url("data:...")`. The schema already
 * refused a reference to a file the package does not carry; one that slips through anyway becomes `none`.
 */
export function inlineAssets(css: string, assets: Readonly<Record<string, string>> | undefined): string {
	return css.replace(ASSET_REF, (_m, a?: string, b?: string, c?: string) => {
		const name = a ?? b ?? c ?? "";
		return assets && Object.hasOwn(assets, name) ? `url("${assets[name]}")` : "none";
	});
}
