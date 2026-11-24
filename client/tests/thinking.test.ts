import { describe, expect, test } from "bun:test";
import { thinkingLabel } from "../src/lib/thinking";
import { THINKING_LEVELS } from "../src/lib/types";

describe("thinkingLabel", () => {
	test("formats every known thinking level with Title Case and XHigh", () => {
		expect(THINKING_LEVELS.map(thinkingLabel)).toEqual(["Off", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
	});

	test("passes through empty or unknown values unchanged", () => {
		expect(thinkingLabel("")).toBe("");
		expect(thinkingLabel("custom")).toBe("custom");
	});
});
