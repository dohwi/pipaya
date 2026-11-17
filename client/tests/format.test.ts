import { describe, expect, test } from "bun:test";
import { clockTime, fileStamp } from "../src/lib/format";

describe("fileStamp", () => {
	test("local date and time, zero padded", () => {
		expect(fileStamp(new Date(2026, 0, 5, 7, 3))).toBe("20260105-0703");
	});
	test("sorts as text in time order", () => {
		expect(fileStamp(new Date(2026, 9, 24, 15, 30)) > fileStamp(new Date(2026, 9, 24, 9, 59))).toBe(true);
		expect(fileStamp(new Date(2027, 0, 1, 0, 0)) > fileStamp(new Date(2026, 11, 31, 23, 59))).toBe(true);
	});
});

describe("clockTime", () => {
	const now = new Date(2026, 10, 17, 9, 30).getTime();
	test("today: the time of day only", () => {
		expect(clockTime(new Date(2026, 10, 17, 8, 56).getTime(), "en-US", now)).toBe("8:56 AM");
		expect(clockTime(new Date(2026, 10, 17, 8, 56).getTime(), "ko-KR", now)).toBe("오전 8:56");
	});
	test("another day: the date in front", () => {
		expect(clockTime(new Date(2026, 10, 16, 21, 5).getTime(), "en-US", now)).toBe("11/16 9:05 PM");
	});
});
