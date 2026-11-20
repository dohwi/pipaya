import { describe, expect, test } from "bun:test";
import { shouldTakeFocus } from "../src/lib/focus-guard";

const inside = (selector: string) => ({ closest: (s: string) => (s.split(", ").includes(selector) ? {} : null) }) as unknown as Element;

describe("shouldTakeFocus", () => {
	test("a pane takes the keyboard when nothing, the page or another control has it", () => {
		expect(shouldTakeFocus(null)).toBe(true);
		expect(shouldTakeFocus(undefined)).toBe(true);
		expect(shouldTakeFocus(inside("button"))).toBe(true);
	});

	test("it leaves the keyboard on the tab strip while the user walks it with the arrow keys", () => {
		expect(shouldTakeFocus(inside('[role="tablist"]'))).toBe(false);
	});

	test("it leaves the keyboard in an open dialog or menu (a search opened while the conversation was still loading)", () => {
		for (const s of ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', "dialog[open]"]) expect(shouldTakeFocus(inside(s))).toBe(false);
	});
});
