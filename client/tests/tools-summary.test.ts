import { describe, expect, test } from "bun:test";
import { peerTargetOf, peerTargetsOf, scheduleIdOf, splitCd, toolIcon, toolSummary } from "../src/lib/tools";

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
	test("the shell, a file read, a peer call and a skill load each have their own icon", () => {
		expect(toolIcon("bash")).toBe("terminal");
		expect(toolIcon("read", { path: "a.ts" })).toBe("file");
		expect(toolIcon("read", { path: "skills/x/SKILL.md" })).toBe("skill");
		expect(toolIcon("glob")).toBe("search");
		expect(toolIcon("peer")).toBe("chat");
		expect(toolIcon("some_mcp_tool")).toBe("bolt");
	});

	test("formats glob and multi-edit summaries cleanly", () => {
		expect(toolSummary("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
		expect(toolSummary("glob", { pattern: "*.svelte", path: "src" })).toBe("*.svelte  in src");
		expect(toolSummary("edit", { path: "a.ts", oldText: "1", newText: "2" })).toBe("a.ts");
		expect(toolSummary("edit", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }, { oldText: "3", newText: "4" }] })).toBe("a.ts (2)");
	});
});

describe("peer tool summary and target", () => {
	test("formats peer actions cleanly instead of dumping JSON", () => {
		expect(toolSummary("peer", { action: "send", to: "서아", message: "작업 확인해줘\n둘째 줄" })).toBe("send · @서아 · 작업 확인해줘");
		expect(toolSummary("peer", { action: "create", title: "UI 전담 세션", message: "구현해줘" })).toBe("create · UI 전담 세션");
		expect(toolSummary("peer", { action: "read", name: "@서아" })).toBe("read · @서아");
		expect(toolSummary("peer", { action: "rename", name: "서아", newName: "지우" })).toBe("rename · @서아 · → @지우");
		expect(toolSummary("peer", { action: "group_create", groupName: "front", members: ["서아", "민수"] })).toBe("group_create · @front · @서아, @민수");
		expect(toolSummary("peer", { action: "list" })).toBe("list");
		expect(toolSummary("peer", {})).toBe("");
	});

	test("resolves the target handle from args or create/group_create output", () => {
		expect(peerTargetOf({ action: "send", to: "@서아" })).toBe("서아");
		expect(peerTargetOf({ action: "read", name: "서아" })).toBe("서아");
		expect(peerTargetOf({ action: "rename", name: "서아", newName: "지우" })).toBe("지우");
		expect(peerTargetOf({ action: "create" }, "Created @서아 (cliproxy/claude-sonnet-5.5, /tmp) and gave it the task.")).toBe("서아");
		expect(peerTargetOf({ action: "create" }, "")).toBeNull();
		expect(peerTargetOf({ action: "group_create" }, "Group @front-team created with 2 sessions.")).toBe("front-team");
		expect(peerTargetOf({ action: "group_add", group: "front-team" })).toBe("front-team");
		expect(peerTargetOf({ action: "list" })).toBeNull();
		expect(peerTargetsOf({ action: "rename", name: "서아", newName: "지우" })).toEqual(["지우", "서아"]);
	});
});

describe("toolSummary for schedule", () => {
	test("names the action, the task and its title or prompt", () => {
		expect(toolSummary("schedule", { action: "create", prompt: "빌드 상태 확인\n둘째 줄", everyMinutes: 60 })).toBe("create · 빌드 상태 확인");
		expect(toolSummary("schedule", { action: "delete", id: "abc" })).toBe("delete · abc");
		expect(toolSummary("schedule", { action: "list" })).toBe("list");
		expect(scheduleIdOf({ action: "update", id: "sched_123" })).toBe("sched_123");
		expect(scheduleIdOf({ action: "create" }, { action: "create", id: "a1b2c3d4" })).toBe("a1b2c3d4");
		expect(scheduleIdOf({ action: "delete", id: "a1b2c3d4" }, { action: "delete", id: "a1b2c3d4" })).toBeNull();
		expect(scheduleIdOf({ action: "list" }, { action: "list", count: 2 })).toBeNull();
	});

	test("workdir shows action and optional path cleanly", () => {
		expect(toolSummary("workdir", { action: "show" })).toBe("show");
		expect(toolSummary("workdir", { action: "move", path: "../app-feat" })).toBe("move · ../app-feat");
		expect(toolSummary("workdir", { action: "back" })).toBe("back");
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
