import { describe, expect, test } from "bun:test";
import { navGroups, phoneBack, phoneStart, touchOnly } from "../src/lib/settings-phone";
import { SETTINGS_TABS } from "../src/lib/settings-search";

describe("phone settings steps", () => {
	test("a plain open shows the list, a direct open the section", () => {
		expect(phoneStart(false)).toBe("list");
		expect(phoneStart(true)).toBe("detail");
	});
	test("back leaves an open extension first, then the section", () => {
		const a = phoneBack({ step: "detail", extId: "x" });
		expect(a).toEqual({ step: "detail", extId: null });
		expect(phoneBack(a)).toEqual({ step: "list", extId: null });
	});
	test("back from the list stays on the list", () => {
		expect(phoneBack({ step: "list", extId: null }).step).toBe("list");
	});
});

describe("touch-only", () => {
	test("needs a coarse pointer and no hover", () => {
		expect(touchOnly({ coarse: true, hover: false })).toBe(true);
		expect(touchOnly({ coarse: true, hover: true })).toBe(false);
		expect(touchOnly({ coarse: false, hover: false })).toBe(false);
	});
});

describe("navGroups", () => {
	test("keeps every section exactly once", () => {
		for (const touch of [true, false]) {
			const g = navGroups(SETTINGS_TABS, touch);
			expect([...g.common, ...g.server, ...g.last].map((x) => x.id).sort()).toEqual(SETTINGS_TABS.map((x) => x.id).sort());
		}
	});
	test("shortcuts sink to the bottom only on touch", () => {
		expect(navGroups(SETTINGS_TABS, true).last.map((x) => x.id)).toEqual(["keys"]);
		expect(navGroups(SETTINGS_TABS, true).common.map((x) => x.id)).not.toContain("keys");
		expect(navGroups(SETTINGS_TABS, false).last).toEqual([]);
		expect(navGroups(SETTINGS_TABS, false).common.map((x) => x.id)).toContain("keys");
	});
});
