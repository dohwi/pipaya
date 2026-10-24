import { describe, expect, test } from "bun:test";
import { raiseSpecificity } from "../src/lib/extensions/style";

// A minimal CSSOM stand-in: the real engine is exercised in the browser check.
class Rule { constructor(public selectorText: string) {} }
class Group { constructor(public cssRules: unknown[]) {} }
Object.assign(globalThis, { CSSStyleRule: Rule, CSSGroupingRule: Group });
const sheet = (rules: unknown[]) => ({ cssRules: rules }) as unknown as CSSStyleSheet;

describe("raiseSpecificity", () => {
	test("puts app selectors behind :root so they outrank scoped rules", () => {
		const r = new Rule("[data-part='header'] .t");
		raiseSpecificity(sheet([r]));
		expect(r.selectorText).toBe(":root:root:root:root:root:root :is([data-part='header'] .t)");
	});
	test("leaves root-level rules alone and reaches into @media", () => {
		const root = new Rule(":root"), body = new Rule("body.x"), inner = new Rule(".a, .b");
		raiseSpecificity(sheet([root, body, new Group([inner])]));
		expect(root.selectorText).toBe(":root");
		expect(body.selectorText).toBe("body.x");
		expect(inner.selectorText).toContain(":is(.a, .b)");
	});
	test("a missing sheet is fine", () => {
		expect(() => raiseSpecificity(null)).not.toThrow();
	});
});
