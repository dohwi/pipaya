import { describe, expect, test } from "bun:test";
import { takeHint, tipLine } from "../src/lib/touch-hint-text";

describe("touch hints", () => {
	test("a hint is shown the first time only", () => {
		const first = takeHint([], "mic-hold");
		expect(first).toEqual({ show: true, seen: ["mic-hold"] });
		expect(takeHint(first.seen, "mic-hold").show).toBe(false);
		expect(takeHint(first.seen, "steer-hold")).toEqual({ show: true, seen: ["mic-hold", "steer-hold"] });
	});
	test("a multi-line tooltip becomes one line", () => {
		expect(tipLine("gpt-5 (openai/gpt-5)\n추론 강도 high\n 1,200 토큰 ")).toBe("gpt-5 (openai/gpt-5) · 추론 강도 high · 1,200 토큰");
	});
});
