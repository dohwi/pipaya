import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { setLang } from "../src/lib/i18n";
import { SETTINGS_TABS, matches, queryWords, searchSettings, toolLabel, type ShortcutEntry } from "../src/lib/settings-search";

beforeEach(() => setLang("ko"));
afterAll(() => setLang("en"));

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
		expect(find("whisper").some((h) => h.target.tab === "sessions" && h.target.sub === "voice")).toBe(true);
		expect(find("받아쓰기").some((h) => h.target.tab === "sessions" && h.target.sub === "voice")).toBe(true);
	});
	test("a loose setting is found by an English keyword and opens the tab that holds it", () => {
		const hit = find("zoom").find((h) => h.key.startsWith("item:"));
		expect(hit).toMatchObject({ title: "화면 배율", target: { tab: "general" } });
	});
	test("subagent delegation is found by its name, in English, and by its old name", () => {
		for (const q of ["서브에이전트", "subagent", "delegate", "도우미"]) expect(find(q).some((h) => h.target.tab === "tools"), q).toBe(true);
	});
	test("guard, devices, and prompt templates are searchable and route to their sub-tabs", () => {
		for (const q of ["명령 보호", "guard", "rm", "wipefs", "force push", "재부팅", "원격 스크립트", "차단"])
			expect(find(q).some((h) => h.target.tab === "tools" && h.target.sub === "guard"), q).toBe(true);
		for (const q of ["프롬프트 템플릿", "template", "/prompt:"])
			expect(find(q).some((h) => h.target.tab === "sessions" && h.target.sub === "templates"), q).toBe(true);
		for (const q of ["접속 기기", "qr", "phone", "페어링"])
			expect(find(q).some((h) => h.target.tab === "info" && h.target.sub === "devices"), q).toBe(true);
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
	test("the nav groups: common sections (내 설정 first) all precede the per-server ones", () => {
		const flags = SETTINGS_TABS.map((x) => x.server);
		expect(SETTINGS_TABS[0]).toMatchObject({ id: "general", label: "내 설정", server: false });
		expect(flags.indexOf(true)).toBe(flags.lastIndexOf(false) + 1);
		expect(SETTINGS_TABS.filter((x) => !x.server).map((x) => x.id)).toEqual(["general", "keys", "backup"]);
	});
	test("settings and shortcut hits land on common sections whatever server is chosen", () => {
		expect(find("zoom").find((h) => h.key.startsWith("item:"))?.where).toBe("내 설정");
		expect(find("ctrl+n", false).find((h) => h.key === "key:newChat")?.target.tab).toBe("keys");
	});
	test("known tools are described; others show their name", () => {
		expect(toolLabel("bash")).toBe("셸 명령 실행 (bash)");
		expect(toolLabel("glob")).toBe("파일 경로 검색 (glob)");
		expect(toolLabel("mcp")).toBe("MCP 서버 조회·추가·변경·삭제 (mcp)");
		expect(toolLabel("my-ext-tool")).toBe("my-ext-tool");
	});
	test("the sections stay compact (3 common + 7 server) in grouped mental-model order", () => {
		const ids = SETTINGS_TABS.map((x) => x.id);
		expect(ids).toEqual(["general", "keys", "backup", "info", "models", "tools", "mcp", "sessions", "schedules", "srvext"]);
	});
});

describe("offline server", () => {
	test("only the info section of a server stays searchable (and not its online-only devices sub-tab)", () => {
		const hits = (q: string) => searchSettings(queryWords(q), { hasServer: true, serverOnline: false, shortcuts: keys });
		expect(hits("서버").map((h) => h.target.tab)).toContain("info");
		expect(hits("페어링").some((h) => h.target.sub === "devices")).toBe(false);
		expect(hits("에이전트").map((h) => h.target.tab)).not.toContain("tools");
		expect(hits("자동 삭제").map((h) => h.target.tab)).not.toContain("sessions");
	});
});
