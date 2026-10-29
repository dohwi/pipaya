import { describe, expect, test } from "bun:test";
import { badgeStyle, toolSummary } from "../src/lib/tools";

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

describe("tool colours", () => {
	const hue = (kind: Parameters<typeof badgeStyle>[0]) => Number(/--th:(\d+)/.exec(badgeStyle(kind))![1]);
	const apart = (a: number, b: number) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));

	test("no kind sits near the failure red (hue ~25)", () => {
		for (const kind of ["read", "ls", "grep", "write", "edit", "bash", "skill", "think", "other", "image"] as const) {
			expect(apart(hue(kind), 25)).toBeGreaterThanOrEqual(25);
		}
	});

	test("every kind has its own hue", () => {
		const kinds = ["read", "ls", "grep", "write", "edit", "bash", "skill", "think", "other", "image"] as const;
		expect(new Set(kinds.map(hue)).size).toBe(kinds.length);
	});
});
