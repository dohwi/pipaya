import { describe, expect, test } from "bun:test";
import { shouldTakeFocus } from "../src/lib/focus-guard";

const inside = (selector: string) => ({ closest: (s: string) => (s === selector ? {} : null) }) as unknown as Element;

describe("shouldTakeFocus", () => {
	test("a pane takes the keyboard when nothing, the page or another control has it", () => {
		expect(shouldTakeFocus(null)).toBe(true);
		expect(shouldTakeFocus(undefined)).toBe(true);
		expect(shouldTakeFocus(inside("button"))).toBe(true);
	});

	test("it leaves the keyboard on the tab strip while the user walks it with the arrow keys", () => {
		expect(shouldTakeFocus(inside('[role="tablist"]'))).toBe(false);
	});
});
