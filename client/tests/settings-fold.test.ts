import { describe, expect, test } from "bun:test";
import { FOLDED_AT_START, initialFolded } from "../src/lib/settings-fold";
import { SETTINGS_TABS } from "../src/lib/settings-search";

describe("settings sections fold state", () => {
	test("MCP and 확장 start folded, every other section starts unfolded", () => {
		expect([...FOLDED_AT_START]).toEqual(["mcp", "srvext"]);
		expect(initialFolded({})).toEqual({ mcp: true, srvext: true });
	});
	test("only real sections are folded", () => {
		const ids = SETTINGS_TABS.map((x) => x.id as string);
		for (const id of FOLDED_AT_START) expect(ids).toContain(id);
		// 대화 and the rest keep their children open
		expect(initialFolded({}).sessions).toBeUndefined();
	});
	test("the user's last choice wins over the defaults", () => {
		expect(initialFolded({ srvext: false, sessions: true })).toEqual({ mcp: true, srvext: false, sessions: true });
	});
	test("broken storage falls back to the defaults", () => {
		for (const bad of [null, "x", 3, ["mcp"]]) expect(initialFolded(bad)).toEqual({ mcp: true, srvext: true });
		expect(initialFolded({ mcp: "no", srvext: false })).toEqual({ mcp: true, srvext: false });
	});
});
