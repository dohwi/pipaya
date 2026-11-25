import { afterEach, describe, expect, test } from "bun:test";
import { activityOf, setGoalActivity, type ActivityView } from "../src/lib/activity";
import { lastPromptOf, sentPrompts } from "../src/lib/composer/input-keys";
import { goalActivity, goalLevel, goalTime, goalTone, goalUsage, resumable } from "../src/lib/goals";
import type { Goal } from "../src/lib/types";

const baseGoal = (over: Partial<Goal> = {}): Goal => ({
	sessionId: "s1",
	goalId: "g1",
	objective: "Fix tests",
	status: "active",
	tokenBudget: null,
	tokensUsed: 142_380,
	timeUsedSeconds: 138,
	createdAt: 1,
	updatedAt: 1,
	...over,
});

afterEach(() => {
	setGoalActivity(() => null);
});

describe("goals helpers", () => {
	test("maps goal statuses to activity, tone, and resumability", () => {
		expect(goalActivity("active")).toBe("working");
		expect(goalActivity("blocked")).toBe("asking");
		expect(goalActivity("usage_limited")).toBe("asking");
		expect(goalActivity("budget_limited")).toBe("asking");
		expect(goalActivity("paused")).toBeNull();
		expect(goalActivity("complete")).toBeNull();

		expect(goalTone("active")).toBe("info");
		expect(goalTone("complete")).toBe("ok");
		expect(goalTone("paused")).toBe("neutral");
		expect(goalTone("blocked")).toBe("warn");
		expect(goalTone("budget_limited")).toBe("warn");

		expect(resumable("paused")).toBe(true);
		expect(resumable("blocked")).toBe(true);
		expect(resumable("usage_limited")).toBe(true);
		expect(resumable("active")).toBe(false);
		expect(resumable("budget_limited")).toBe(false);
		expect(resumable("complete")).toBe(false);
	});

	test("formats usage, duration, and warning levels", () => {
		expect(goalTime(45)).toBe("45초");
		expect(goalTime(120)).toBe("2분");
		expect(goalTime(138)).toBe("2분 18초");
		expect(goalTime(3600)).toBe("1시간");
		expect(goalTime(3720)).toBe("1시간 2분");

		expect(goalUsage(baseGoal({ tokenBudget: null }))).toBe("142k · 2분 18초");
		expect(goalUsage(baseGoal({ tokenBudget: 500_000 }))).toBe("142k / 500k");

		expect(goalLevel(baseGoal({ tokenBudget: 500_000, tokensUsed: 100_000 }))).toBe("");
		expect(goalLevel(baseGoal({ tokenBudget: 500_000, tokensUsed: 400_000 }))).toBe("warn");
		expect(goalLevel(baseGoal({ status: "budget_limited", tokenBudget: 500_000, tokensUsed: 500_000 }))).toBe("danger");
	});
});

describe("activityOf with goal status", () => {
	const empty: ActivityView = { running: {}, awaiting: {}, unread: {}, failed: {} };

	test("keeps active goal as working and stopped-short goal as asking, outranking unread done", () => {
		setGoalActivity((id) => (id === "a" ? "working" : id === "b" ? "asking" : null));
		expect(activityOf({ ...empty, unread: { a: true, b: true } }, "a")).toBe("working");
		expect(activityOf({ ...empty, unread: { a: true, b: true } }, "b")).toBe("asking");
		expect(activityOf({ ...empty, unread: { c: true } }, "c")).toBe("done");
	});

	test("real asking, running, and failed states outrank goal activity", () => {
		setGoalActivity(() => "working");
		expect(activityOf({ ...empty, awaiting: { s1: 1 } }, "s1")).toBe("asking");
		expect(activityOf({ ...empty, failed: { s1: true } }, "s1")).toBe("failed");
	});
});

describe("prompt recall skips automatic goal continuations", () => {
	test("lastPromptOf and sentPrompts ignore user items marked goal: true", () => {
		const items = [
			{ kind: "user", text: "/goal fix all tests" },
			{ kind: "assistant", text: "turn 1" },
			{ kind: "user", text: "Continue working toward the active session goal.", goal: true },
			{ kind: "assistant", text: "turn 2" },
			{ kind: "user", text: "Continue working toward the active session goal.", goal: true },
		];
		expect(lastPromptOf(items)).toBe("/goal fix all tests");
		expect(sentPrompts(items)).toEqual(["/goal fix all tests"]);
	});
});
