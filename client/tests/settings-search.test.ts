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
	test("a server section is found by its name and opens that tab", () => {
		const hit = find("백업").find((h) => h.key === "tab:backup");
		expect(hit?.target).toEqual({ tab: "backup" });
	});
	test("the voice fields are found by their own words", () => {
		expect(find("whisper").some((h) => h.target.tab === "voice")).toBe(true);
		expect(find("받아쓰기").some((h) => h.target.tab === "voice")).toBe(true);
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
		expect(find("에이전트", false).some((h) => h.key === "tab:tools")).toBe(false);
		expect(find("에이전트", true).some((h) => h.key === "tab:tools")).toBe(true);
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
	test("the sections follow setup order: device, the server, then what grows over time", () => {
		const ids = SETTINGS_TABS.map((x) => x.id);
		// the app-wide ones first, then the server's, and no server section in front of "정보"
		expect(ids.slice(0, ids.indexOf("info"))).toEqual(["general", "keys", "backup"]);
		expect(ids.indexOf("info")).toBeLessThan(ids.indexOf("models"));
		// voice input is a connection like the models, so it sits right after them
		expect(ids.indexOf("voice")).toBe(ids.indexOf("models") + 1);
		// the sections that grow over time come last
		expect(ids.slice(-2)).toEqual(["srvext", "devices"]);
	});
});

describe("offline server", () => {
	test("only the info section of a server stays searchable", () => {
		const ids = (q: string) => searchSettings(queryWords(q), { hasServer: true, serverOnline: false, shortcuts: keys }).map((h) => h.target.tab);
		expect(ids("정보")).toContain("info");
		expect(ids("에이전트")).not.toContain("tools");
		expect(ids("자동 삭제")).not.toContain("sessions");
	});
});
