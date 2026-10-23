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
	test("viewport meta narrows the layout width as the scale grows", () => {
		expect(viewportContent(400, 100)).toContain("width=device-width");
		expect(viewportContent(400, 200)).toContain("width=200,");
		expect(viewportContent(400, 50)).toContain("width=800,");
	});
});
