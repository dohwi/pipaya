import { ASSET_REF } from "./schema";
/**
 * An extension stylesheet has to beat the app's own: Svelte scopes every built-in rule (`header.svelte-x`,
 * `.a.svelte-x .b.svelte-x`), which outranks a plain `[data-part="header"]`. So each style rule's selector is placed
 * behind a few `:root`s, which raises its specificity above any scoped rule without `!important`.
 * Rules at the top level and inside `@media` / `@supports` / `@layer` are handled; `@keyframes` and `@font-face` stay as they are.
 */
const BOOST = ":root:root:root:root:root:root";

/** Selectors that already name the root are left alone (`:root { --x: 1 }`, `html`, `body`): they are not inside the app's scoped rules. */
const ROOTISH = /^\s*(?::root|html|body)\b/;

export function raiseSpecificity(sheet: CSSStyleSheet | null | undefined): void {
	if (!sheet) return;
	const walk = (rules: CSSRuleList) => {
		for (const rule of Array.from(rules)) {
			if (rule instanceof CSSStyleRule) {
				if (!ROOTISH.test(rule.selectorText)) rule.selectorText = `${BOOST} :is(${rule.selectorText})`;
			} else if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
		}
	};
	walk(sheet.cssRules);
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
