import { describe, expect, test } from "bun:test";
import { ApiError, errorText } from "../src/lib/api";

describe("errorText", () => {
	test("message of an Error, a string as is", () => {
		expect(errorText(new Error("boom"))).toBe("boom");
		expect(errorText("plain")).toBe("plain");
	});
	test("fallback only when there is no message", () => {
		expect(errorText(new Error(""), "later")).toBe("later");
		expect(errorText(new Error("boom"), "later")).toBe("boom");
		expect(errorText(null)).not.toBe("");
	});
	test("a bare browser network error is not shown in the browser's English", () => {
		expect(errorText(new TypeError("Failed to fetch"))).not.toMatch(/fetch/i);
		expect(errorText(new TypeError("Load failed"))).not.toMatch(/load/i);
	});
	test("an unreachable server and a refused token have their own words", () => {
		expect(errorText(new ApiError(0, "network", "x"))).not.toBe("x");
		expect(errorText(new ApiError(401, "unauthorized", "x"))).not.toBe("x");
	});
});
