import { describe, expect, test } from "bun:test";
import { browserLabel, isBrowserId, modifiersOf, parseProfileState } from "../src/lib/browser";

describe("profile file", () => {
	test("takes a storage state, with or without origins", () => {
		expect(parseProfileState('{"cookies":[{"name":"a","value":"b"}],"origins":[{"origin":"https://x.test","localStorage":[]}]}')).toEqual({
			cookies: [{ name: "a", value: "b" }],
			origins: [{ origin: "https://x.test", localStorage: [] }],
		});
		expect(parseProfileState('{"cookies":[]}')).toEqual({ cookies: [], origins: [] });
	});
	test("refuses anything else", () => {
		for (const bad of ["", "not json", "[]", "null", '{"origins":[]}', '{"cookies":"x"}', '{"cookies":[1]}', '{"cookies":[],"origins":[[]]}']) expect(parseProfileState(bad)).toBeNull();
	});
});

describe("browser helpers", () => {
	test("ids and labels", () => {
		expect(isBrowserId("web_1")).toBe(true);
		expect(isBrowserId("term_1")).toBe(false);
		expect(isBrowserId(null)).toBe(false);
		expect(browserLabel({ title: "Docs", url: "https://a.test/" }, "Browser")).toBe("Docs");
		expect(browserLabel({ title: " ", url: "https://a.test/x" }, "Browser")).toBe("a.test/x");
		expect(browserLabel({ title: "", url: "about:blank" }, "Browser")).toBe("Browser");
	});
	test("modifier bits follow the DevTools protocol (Alt 1, Ctrl 2, Meta 4, Shift 8)", () => {
		expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(1);
		expect(modifiersOf({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(10);
		expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
	});
});
