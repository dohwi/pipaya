import { expect, test } from "vitest";
import { parseRetrying, secondsLeft } from "../src/lib/retry-state";

test("parses a full run_retrying payload", () => {
	const r = parseRetrying({ attempt: 2, maxRetries: 6, delayMs: 4000, reason: "connect ECONNREFUSED" }, 1000);
	expect(r).toEqual({ attempt: 2, maxRetries: 6, delayMs: 4000, reason: "connect ECONNREFUSED", at: 1000 });
});

test("an older server without delayMs/reason still works", () => {
	const r = parseRetrying({ attempt: 1, maxRetries: 6 }, 5);
	expect(r.delayMs).toBe(0);
	expect(r.reason).toBe("");
	expect(secondsLeft(r, 99999)).toBe(0);
});

test("caps a long reason and ignores a non-string", () => {
	expect(parseRetrying({ reason: "x".repeat(300) }, 0).reason.length).toBe(200);
	expect(parseRetrying({ reason: 5 }, 0).reason).toBe("");
});

test("the countdown rounds up and stops at 0", () => {
	const r = parseRetrying({ attempt: 1, maxRetries: 3, delayMs: 2000 }, 1000);
	expect(secondsLeft(r, 1000)).toBe(2);
	expect(secondsLeft(r, 2100)).toBe(1);
	expect(secondsLeft(r, 3000)).toBe(0);
	expect(secondsLeft(r, 9000)).toBe(0);
});
