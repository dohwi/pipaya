import { describe, expect, test } from "bun:test";
import { splitCd, toolIcon, toolSummary } from "../src/lib/tools";

describe("toolSummary for ask_user", () => {
	test("shows the question text, not its JSON", () => {
		expect(toolSummary("ask_user", { question: "어느 쪽으로 할까요?" })).toBe("어느 쪽으로 할까요?");
	});

	test("with several questions names the first and counts the rest", () => {
		const args = { questions: [{ question: "A?" }, { question: "B?" }, { question: "C?" }] };
		expect(toolSummary("ask_user", args)).toBe("A? (+2)");
	});

	test("a lone entry in questions has no counter", () => {
		expect(toolSummary("ask_user", { questions: [{ question: "A?" }] })).toBe("A?");
	});

	test("without a question it is empty rather than throwing", () => {
		expect(toolSummary("ask_user", {})).toBe("");
	});

	test("long questions are clipped", () => {
		expect(toolSummary("ask_user", { question: "x".repeat(300) }).length).toBeLessThanOrEqual(91);
	});
});

describe("tool icons", () => {
	test("the shell, a file read and a skill load each have their own icon", () => {
		expect(toolIcon("bash")).toBe("terminal");
		expect(toolIcon("read", { path: "a.ts" })).toBe("file");
		expect(toolIcon("read", { path: "skills/x/SKILL.md" })).toBe("skill");
		expect(toolIcon("some_mcp_tool")).toBe("bolt");
	});
});

describe("toolSummary for schedule", () => {
	test("names the action, the task and its title or prompt", () => {
		expect(toolSummary("schedule", { action: "create", prompt: "빌드 상태 확인\n둘째 줄", everyMinutes: 60 })).toBe("create · 빌드 상태 확인");
		expect(toolSummary("schedule", { action: "delete", id: "abc" })).toBe("delete · abc");
		expect(toolSummary("schedule", { action: "list" })).toBe("list");
	});
});

describe("splitCd", () => {
	test("takes the leading cd off a command", () => {
		expect(splitCd("cd ../app && git pull -q --ff-only")).toEqual({ dir: "../app", rest: "git pull -q --ff-only" });
	});

	test("a chain of cds keeps the last folder", () => {
		expect(splitCd("cd /srv; cd app && ls")).toEqual({ dir: "app", rest: "ls" });
	});

	test("a quoted folder loses its quotes", () => {
		expect(splitCd(`cd "my dir" && make`)).toEqual({ dir: "my dir", rest: "make" });
	});

	test("a command without a leading cd is left alone", () => {
		expect(splitCd("git status && cd x")).toEqual({ dir: "", rest: "git status && cd x" });
	});

	test("a lone cd stays the work", () => {
		expect(splitCd("cd ../app")).toEqual({ dir: "", rest: "cd ../app" });
	});

	test("only the first line counts", () => {
		expect(splitCd("cd a && echo 1\necho 2")).toEqual({ dir: "a", rest: "echo 1" });
	});

	test("the bash summary is the work after the cd", () => {
		expect(toolSummary("bash", { command: "cd ../app && git fetch" })).toBe("git fetch");
	});
});
