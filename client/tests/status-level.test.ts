import { describe, expect, test } from "bun:test";
import { cacheLevel, contextLevel, costLevel, high, low, speedLevel } from "../src/lib/status-level";

describe("status line levels", () => {
	test("context: amber from 20%, red from 40%", () => {
		expect(contextLevel(5.5)).toBe("");
		expect(contextLevel(19.9)).toBe("");
		expect(contextLevel(20)).toBe("warn");
		expect(contextLevel(39.9)).toBe("warn");
		expect(contextLevel(40)).toBe("danger");
		expect(contextLevel(100)).toBe("danger");
	});
	test("no value, no colour", () => {
		expect(contextLevel(null)).toBe("");
		expect(high(NaN, 1, 2)).toBe("");
		expect(low(null, 1, 2)).toBe("");
		expect(speedLevel(null)).toBe("");
	});
	test("cache: low hit rates are bad, but only once there are a few calls", () => {
		expect(cacheLevel(96, 5)).toBe("");
		expect(cacheLevel(50, 5)).toBe("warn");
		expect(cacheLevel(10, 5)).toBe("danger");
		expect(cacheLevel(0, 1)).toBe(""); // the first call can never hit the cache
	});
	test("speed: slow is bad", () => {
		expect(speedLevel(108)).toBe("");
		expect(speedLevel(15)).toBe("warn");
		expect(speedLevel(5)).toBe("danger");
	});
	test("cost: grows into amber and red", () => {
		expect(costLevel(0.2)).toBe("");
		expect(costLevel(1)).toBe("warn");
		expect(costLevel(5)).toBe("danger");
	});
});
