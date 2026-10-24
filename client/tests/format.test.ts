import { describe, expect, test } from "bun:test";
import { fileStamp } from "../src/lib/format";

describe("fileStamp", () => {
	test("local date and time, zero padded", () => {
		expect(fileStamp(new Date(2026, 0, 5, 7, 3))).toBe("20260105-0703");
	});
	test("sorts as text in time order", () => {
		expect(fileStamp(new Date(2026, 9, 24, 15, 30)) > fileStamp(new Date(2026, 9, 24, 9, 59))).toBe(true);
		expect(fileStamp(new Date(2027, 0, 1, 0, 0)) > fileStamp(new Date(2026, 11, 31, 23, 59))).toBe(true);
	});
});
