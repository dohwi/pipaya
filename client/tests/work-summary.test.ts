import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setLang } from "../src/lib/i18n";
import type { Step } from "../src/lib/types";
import { joinAnd, workIcon, workKind, workSummary } from "../src/lib/work-summary";

afterEach(() => setLang("ko"));

const tool = (name: string, args: Record<string, unknown> = {}): Step => ({ kind: "tool", id: `${name}-${Math.random()}`, name, args });
const think: Step = { kind: "think", text: "…", done: true };
const many = (n: number, name: string, args: Record<string, unknown> = {}) => Array.from({ length: n }, () => tool(name, args));

describe("workKind", () => {
	test("groups the built-in tools by what they do", () => {
		expect(workKind("bash")).toBe("bash");
		expect(workKind("read", { path: "a.ts" })).toBe("read");
		expect(workKind("write")).toBe("edit");
		expect(workKind("edit")).toBe("edit");
		expect(workKind("grep")).toBe("search");
		expect(workKind("glob")).toBe("search");
		expect(workKind("ls")).toBe("search");
		expect(workKind("delegate")).toBe("delegate");
		expect(workKind("generate_image")).toBe("image");
	});
	test("a read of a SKILL.md is a skill, not a file", () => {
		expect(workKind("read", { path: "/x/skills/readme/SKILL.md" })).toBe("skill");
	});
	test("web tools are recognised by name, whatever server provides them", () => {
		for (const n of ["web_search", "mcp_search_web_fetch", "fetch_url", "browse"]) expect(workKind(n), n).toBe("web");
		expect(workKind("peer")).toBe("other");
		expect(workKind("ask_user")).toBe("other");
	});
});

describe("workIcon", () => {
	test("the kind the summary names first", () => {
		expect(workIcon(many(3, "bash"))).toBe("terminal");
		expect(workIcon([tool("web_search"), tool("bash")])).toBe("globe");
		expect(workIcon([tool("peer"), tool("read", { path: "a" })])).toBe("file");
	});
	test("unknown tools only: a bolt; thoughts only: a brain", () => {
		expect(workIcon([tool("peer")])).toBe("bolt");
		expect(workIcon([think])).toBe("brain");
		expect(workIcon([])).toBe("brain");
	});
});

describe("workSummary (Korean)", () => {
	test("one kind", () => {
		expect(workSummary(many(10, "bash"))).toBe("명령 10개 실행");
	});
	test("two kinds are joined with 및, in the order they first appeared", () => {
		expect(workSummary([...many(4, "bash"), tool("web_search")])).toBe("명령 4개 실행 및 웹 1회 검색");
		expect(workSummary([tool("web_search"), ...many(2, "bash")])).toBe("웹 1회 검색 및 명령 2개 실행");
	});
	test("three kinds: commas, then 및 before the last", () => {
		expect(workSummary([tool("read", { path: "a" }), tool("edit"), tool("write"), tool("grep")])).toBe("파일 1개 읽음, 파일 2개 수정 및 검색 1회");
	});
	test("tools of no known kind come last as 도구 N개 사용", () => {
		expect(workSummary([tool("peer"), tool("bash"), tool("schedule")])).toBe("명령 1개 실행 및 도구 2개 사용");
	});
	test("more than three kinds: the first two, then the rest counted together", () => {
		const steps = [tool("bash"), tool("read", { path: "a" }), tool("grep"), tool("delegate"), tool("peer")];
		expect(workSummary(steps)).toBe("명령 1개 실행, 파일 1개 읽음 및 그 밖의 도구 3개 사용");
	});
	test("skill stays visible instead of being lumped into other tools when 4+ kinds appear", () => {
		const steps = [tool("bash"), tool("read", { path: "a" }), tool("grep"), tool("read", { path: "/s/x/SKILL.md" })];
		expect(workSummary(steps)).toBe("명령 1개 실행, 스킬 1개 불러옴 및 그 밖의 도구 2개 사용");
		expect(workIcon(steps)).toBe("terminal");
	});
	test("exactly three kinds including other: no lumping", () => {
		expect(workSummary([tool("bash"), tool("grep"), tool("peer")])).toBe("명령 1개 실행, 검색 1회 및 도구 1개 사용");
	});
	test("thoughts do not count; a box of thoughts only is 생각 과정", () => {
		expect(workSummary([think, tool("bash"), think])).toBe("명령 1개 실행");
		expect(workSummary([think])).toBe("생각 과정");
		expect(workSummary([])).toBe("생각 과정");
	});
});

describe("workSummary (English)", () => {
	test("plural and singular forms, capitalised first word, 'and' before the last", () => {
		setLang("en");
		expect(workSummary(many(10, "bash"))).toBe("Ran 10 commands");
		expect(workSummary([...many(4, "bash"), tool("web_search")])).toBe("Ran 4 commands and searched the web 1 time");
		expect(workSummary([tool("read", { path: "a" }), tool("edit"), tool("grep"), tool("grep")])).toBe("Read 1 file, edited 1 file and searched 2 times");
		expect(workSummary([tool("read", { path: "/s/x/SKILL.md" })])).toBe("Loaded 1 skill");
		expect(workSummary([think])).toBe("Thinking");
	});
	test("joinAnd", () => {
		setLang("en");
		expect(joinAnd([])).toBe("");
		expect(joinAnd(["a"])).toBe("a");
		expect(joinAnd(["a", "b", "c"])).toBe("a, b and c");
	});
});

describe("WorkBox", () => {
	const src = readFileSync(new URL("../src/components/chat/WorkBox.svelte", import.meta.url), "utf8");
	test("opens its steps in place instead of a dialog, and says whether it is open", () => {
		expect(src).not.toContain("<Modal");
		expect(src).toMatch(/aria-expanded=\{open\}/);
		expect(src).toMatch(/class="steps"[^>]*in:collapseIn out:collapseOut/);
	});
});
