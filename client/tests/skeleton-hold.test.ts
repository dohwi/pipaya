import { describe, expect, test } from "bun:test";
import { SKELETON_DELAY_MS as D, SKELETON_MIN_MS as M, skeletonHold } from "../src/lib/skeleton-hold";

describe("skeletonHold", () => {
	test("a load that beat the fade-in delay swaps at once (the skeleton was never seen)", () => {
		expect(skeletonHold(1000, 1000)).toBe(0);
		expect(skeletonHold(1000, 1000 + D)).toBe(0);
	});
	test("a skeleton that just became visible stays for the minimum", () => {
		expect(skeletonHold(1000, 1000 + D + 1)).toBe(M - 1);
		expect(skeletonHold(1000, 1000 + D + 100)).toBe(M - 100);
	});
	test("one that was on screen long enough goes at once", () => {
		expect(skeletonHold(1000, 1000 + D + M)).toBe(0);
		expect(skeletonHold(1000, 1000 + 5000)).toBe(0);
	});
	test("custom delay and minimum", () => {
		expect(skeletonHold(0, 50, 0, 200)).toBe(150);
	});
});
