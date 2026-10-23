import { describe, expect, test } from "bun:test";
import { clampScale, stepScale, viewportContent } from "../src/lib/ui-scale";

describe("ui scale", () => {
	test("clamps and snaps to steps", () => {
		expect(clampScale(undefined)).toBe(100);
		expect(clampScale("x")).toBe(100);
		expect(clampScale(10)).toBe(50);
		expect(clampScale(999)).toBe(200);
		expect(clampScale(104)).toBe(100);
	});
	test("steps within limits", () => {
		expect(stepScale(100, 1)).toBe(110);
		expect(stepScale(100, -1)).toBe(90);
		expect(stepScale(200, 1)).toBe(200);
		expect(stepScale(50, -1)).toBe(50);
	});
	test("viewport meta zooms out below 100% only", () => {
		expect(viewportContent(100)).toContain("initial-scale=1,");
		expect(viewportContent(150)).toContain("initial-scale=1,");
		expect(viewportContent(50)).toContain("initial-scale=0.50,");
	});
});
