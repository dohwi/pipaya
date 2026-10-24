import { describe, expect, test } from "bun:test";
import { SETTINGS_TABS, matches, queryWords, searchSettings, toolLabel, type ShortcutEntry } from "../src/lib/settings-search";

const keys: ShortcutEntry[] = [{ id: "newChat", label: "새 대화", combo: "Mod+N", shown: "Ctrl+N" }];
const find = (q: string, hasServer = true) => searchSettings(queryWords(q), { hasServer, shortcuts: keys });

describe("query words", () => {
	test("split on whitespace and ignore case", () => {
		expect(queryWords("  Dark   Theme ")).toEqual(["dark", "theme"]);
		expect(queryWords("   ")).toEqual([]);
	});
	test("every word has to match", () => {
		expect(matches(["dark", "theme"], "Theme: dark mode")).toBe(true);
		expect(matches(["dark", "font"], "Theme: dark mode")).toBe(false);
	});
});

describe("settings search", () => {
	test("an empty query finds nothing", () => {
		expect(find("")).toEqual([]);
	});
	test("a section is found by its name and opens that tab", () => {
		const hit = find("백업").find((h) => h.key === "tab:backup");
		expect(hit?.target).toEqual({ tab: "backup" });
	});
	test("a loose setting is found by an English keyword and opens the tab that holds it", () => {
		const hit = find("zoom").find((h) => h.key.startsWith("item:"));
		expect(hit).toMatchObject({ title: "화면 배율", target: { tab: "general" } });
	});
	test("a shortcut is found by its keys and hands its name to the shortcut list as a filter", () => {
		const hit = find("ctrl+n").find((h) => h.key === "key:newChat");
		expect(hit).toMatchObject({ combo: "Ctrl+N", target: { tab: "keys", keyFilter: "새 대화" } });
	});
	test("server sections are left out when there is no server", () => {
		expect(find("에이전트", false).some((h) => h.key === "tab:agent")).toBe(false);
		expect(find("에이전트", true).some((h) => h.key === "tab:agent")).toBe(true);
	});
});

describe("tabs and tool labels", () => {
	test("tab ids are unique", () => {
		const ids = SETTINGS_TABS.map((x) => x.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
	test("known tools are described; others show their name", () => {
		expect(toolLabel("bash")).toBe("셸 명령 실행 (bash)");
		expect(toolLabel("my-ext-tool")).toBe("my-ext-tool");
	});
});
