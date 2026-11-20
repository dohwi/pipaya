import { describe, expect, test } from "bun:test";
import { guardSelector, prepareSheet, SEE_THROUGH, splitSelectors } from "../src/lib/extensions/style";

// A minimal CSSOM stand-in: the real engine is exercised in the browser check (and the rules below in a real browser).
class Style {
	props = new Map<string, [string, string]>();
	constructor(decls: Record<string, string> = {}) { for (const [k, v] of Object.entries(decls)) this.props.set(k, [v, ""]); }
	[Symbol.iterator]() { return this.props.keys(); }
	getPropertyValue(p: string) { return this.props.get(p)?.[0] ?? ""; }
	getPropertyPriority(p: string) { return this.props.get(p)?.[1] ?? ""; }
	removeProperty(p: string) { this.props.delete(p); }
}
class Rule { style: Style; constructor(public selectorText: string, decls?: Record<string, string>) { this.style = new Style(decls); } }
class Group {
	constructor(public cssRules: unknown[]) {}
	insertRule(text: string, i: number) { const m = /^(.*?)\s*\{\s*(.*)\}$/s.exec(text)!; const decls = Object.fromEntries(m[2]!.split(";").map(d => d.trim()).filter(Boolean).map(d => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()])); this.cssRules.splice(i, 0, new Rule(m[1]!, decls)); return i; }
	deleteRule(i: number) { this.cssRules.splice(i, 1); }
}
Object.assign(globalThis, { CSSStyleRule: Rule, CSSGroupingRule: Group });
const sheet = (rules: unknown[]) => new Group(rules) as unknown as CSSStyleSheet;
const OFF = ":not([data-logo-frame], [data-logo-frame] :has([data-pipaya-logo]), [data-pipaya-logo])";
const HOLDS = ":not(:has([data-pipaya-logo]))";
const BOOST = ":root:root:root:root:root:root ";

describe("prepareSheet", () => {
	test("puts app selectors behind :root so they outrank scoped rules, and keeps them off the logo", () => {
		const r = new Rule("[data-part='header'] .t", { color: "red" });
		prepareSheet(sheet([r]));
		expect(r.selectorText).toBe(`${BOOST}:is([data-part='header'] .t)${OFF}`);
	});
	test("root-level rules are not raised but are still kept off the logo; @media is walked", () => {
		const root = new Rule(":root", { "--x": "1" }), body = new Rule("body.x", { color: "red" }), inner = new Rule(".a, .b", { color: "red" });
		prepareSheet(sheet([root, body, new Group([inner])]));
		expect(root.selectorText).toBe(`:is(:root)${OFF}`);
		expect(body.selectorText).toBe(`:is(body.x)${OFF}`);
		expect(inner.selectorText).toBe(`${BOOST}:is(.a)${OFF}, ${BOOST}:is(.b)${OFF}`);
	});
	test("hiding, fading or transforming moves to a rule that skips every element holding a logo", () => {
		const r = new Rule(".side, .x", { opacity: "0", color: "red", transform: "scale(0)" });
		const s = sheet([r]);
		prepareSheet(s);
		const rules = (s as unknown as Group).cssRules as Rule[];
		expect(rules).toHaveLength(2);
		expect([...rules[0]!.style]).toEqual(["color"]);
		expect(rules[1]!.selectorText).toBe(`${BOOST}:is(.side)${OFF}${HOLDS}, ${BOOST}:is(.x)${OFF}${HOLDS}`);
		expect([...rules[1]!.style].sort()).toEqual(["opacity", "transform"]);
	});
	test("a pseudo element is never drawn by an element that holds a logo", () => {
		const r = new Rule("body::after, .a:before", { content: '""', position: "fixed" });
		prepareSheet(sheet([r]));
		expect(r.selectorText).toBe(`:is(body)${OFF}${HOLDS}::after, ${BOOST}:is(.a)${OFF}${HOLDS}:before`);
	});
	test("a rule the engine refuses to rewrite is dropped, not left unguarded", () => {
		const locked = new Rule(".a", { opacity: "0" });
		Object.defineProperty(locked, "selectorText", { get: () => ".a", set: () => {} });
		const s = sheet([locked]);
		prepareSheet(s);
		expect((s as unknown as Group).cssRules).toHaveLength(0);
	});
	test("a missing sheet is fine", () => {
		expect(() => prepareSheet(null)).not.toThrow();
	});
});

describe("selectors", () => {
	test("lists split on top-level commas only", () => {
		expect(splitSelectors(':is(.a, .b) > p, [x="a,b"], .c')).toEqual([":is(.a, .b) > p", '[x="a,b"]', ".c"]);
	});
	test("a nested rule is not raised again", () => {
		expect(guardSelector("& .a", true)).toBe(`:is(& .a)${OFF}`);
	});
	test("what counts as changing everything inside an element", () => {
		for (const p of ["display", "visibility", "opacity", "filter", "transform", "clip-path", "mask-image", "content", "zoom"]) expect(SEE_THROUGH.test(p)).toBe(true);
		for (const p of ["color", "background", "font-family", "border-color", "padding", "width", "--accent"]) expect(SEE_THROUGH.test(p)).toBe(false);
	});
});
