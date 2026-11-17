import { describe, expect, test } from "bun:test";
import { dayLabel, dayStart, fileStamp, timeOfDay } from "../src/lib/format";

describe("fileStamp", () => {
	test("local date and time, zero padded", () => {
		expect(fileStamp(new Date(2026, 0, 5, 7, 3))).toBe("20260105-0703");
	});
	test("sorts as text in time order", () => {
		expect(fileStamp(new Date(2026, 9, 24, 15, 30)) > fileStamp(new Date(2026, 9, 24, 9, 59))).toBe(true);
		expect(fileStamp(new Date(2027, 0, 1, 0, 0)) > fileStamp(new Date(2026, 11, 31, 23, 59))).toBe(true);
	});
});

describe("timeOfDay", () => {
	test("the time of day only, in the locale's own form", () => {
		expect(timeOfDay(new Date(2026, 10, 17, 8, 56).getTime(), "en-US")).toBe("8:56 AM");
		expect(timeOfDay(new Date(2026, 10, 17, 8, 56).getTime(), "ko-KR")).toBe("오전 8:56");
	});
});

describe("dayLabel", () => {
	const now = new Date(2026, 10, 17, 0, 5).getTime(); // five past midnight: a minute ago was yesterday
	test("today and yesterday by name", () => {
		expect(dayLabel(new Date(2026, 10, 17, 0, 1).getTime(), "ko-KR", now)).toBe("오늘");
		expect(dayLabel(new Date(2026, 10, 16, 23, 59).getTime(), "ko-KR", now)).toBe("어제");
		expect(dayLabel(new Date(2026, 10, 16, 23, 59).getTime(), "en-US", now)).toBe("yesterday");
	});
	test("older days: date and weekday, the year only when it is another year", () => {
		expect(dayLabel(new Date(2026, 10, 15, 12).getTime(), "ko-KR", now)).toBe("11월 15일 (일)");
		expect(dayLabel(new Date(2025, 10, 16, 12).getTime(), "en-US", now)).toBe("Sun, November 16, 2025");
	});
	test("dayStart groups times by their local day", () => {
		expect(dayStart(new Date(2026, 10, 17, 23, 59).getTime())).toBe(dayStart(new Date(2026, 10, 17, 0, 0).getTime()));
		expect(dayStart(new Date(2026, 10, 18, 0, 0).getTime())).not.toBe(dayStart(new Date(2026, 10, 17, 23, 59).getTime()));
	});
});
