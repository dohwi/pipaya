import { describe, expect, test } from "bun:test";
import { setLang } from "../src/lib/i18n";
import { groupNameFor } from "../src/lib/group-name";

describe("groupNameFor", () => {
	test("one shared folder, or the distinct folders joined, at most three", () => {
		expect(groupNameFor(["/w/pipaya", "/w/pipaya/"], new Set())).toBe("pipaya");
		expect(groupNameFor(["/w/a", "/w/b"], new Set())).toBe("a / b");
		expect(groupNameFor(["/a", "/b", "/c", "/d", "/e"], new Set())).toBe("a / b / c / +2");
		expect(groupNameFor(["C:\\work\\app"], new Set())).toBe("app");
	});
	test("a taken name gets the next free number", () => {
		expect(groupNameFor(["/w/a"], new Set(["a", "a 2"]))).toBe("a 3");
	});
	test("no folder known: the first free Group N", () => {
		setLang("ko");
		expect(groupNameFor([undefined, ""], new Set(["그룹 1"]))).toBe("그룹 2");
	});
});
