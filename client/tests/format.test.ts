import { afterAll, describe, expect, test } from "bun:test";
import { clockMinutes, dayLabel, duration, nextChange, pastChange, dayStart, fileStamp, fullTime, messageTime, pastLabel, shortDate, shortDateTime, timeOfDay } from "../src/lib/format";
import { setLang } from "../src/lib/i18n";

afterAll(() => setLang("en"));

describe("duration", () => {
	test("formats localized durations in Korean and English without 60s rollover", () => {
		setLang("ko");
		expect(duration(-50)).toBe("0ms");
		expect(duration(420)).toBe("420ms");
		expect(duration(3_450)).toBe("3.5초");
		expect(duration(59_949)).toBe("59.9초");
		expect(duration(59_950)).toBe("1분");
		expect(duration(119_600)).toBe("2분");
		expect(duration(125_000)).toBe("2분 5초");
		expect(duration(3_600_000)).toBe("1시간");
		expect(duration(3_900_000)).toBe("1시간 5분");

		setLang("en");
		expect(duration(420)).toBe("420ms");
		expect(duration(3_450)).toBe("3.5s");
		expect(duration(59_949)).toBe("59.9s");
		expect(duration(59_950)).toBe("1m");
		expect(duration(119_600)).toBe("2m");
		expect(duration(125_000)).toBe("2m 5s");
		expect(duration(3_600_000)).toBe("1h");
		expect(duration(3_900_000)).toBe("1h 5m");
		setLang("ko");
	});
});

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
		// Korean keeps the weekday in brackets with the year too, as the headings without it do
		expect(dayLabel(new Date(2025, 9, 18, 12).getTime(), "ko-KR", now)).toBe("2025년 10월 18일 (토)");
		expect(dayLabel(new Date(2026, 9, 13, 12).getTime(), "ko-KR", now)).toBe("10월 13일 (화)");
	});
	test("dayStart groups times by their local day", () => {
		expect(dayStart(new Date(2026, 10, 17, 23, 59).getTime())).toBe(dayStart(new Date(2026, 10, 17, 0, 0).getTime()));
		expect(dayStart(new Date(2026, 10, 18, 0, 0).getTime())).not.toBe(dayStart(new Date(2026, 10, 17, 23, 59).getTime()));
	});
});

describe("fullTime / shortDate / shortDateTime", () => {
	const ts = new Date(2026, 10, 19, 15, 4, 5).getTime();
	test("follow the app's language, not the browser's", () => {
		setLang("en");
		expect(fullTime(ts)).toBe(new Date(ts).toLocaleString("en-US"));
		expect(shortDate(ts)).toBe("Nov 19");
		setLang("ko");
		expect(fullTime(ts)).toBe(new Date(ts).toLocaleString("ko-KR"));
		expect(shortDate(ts)).toBe("11월 19일");
	});
	test("a day and a time, no year or seconds", () => {
		expect(shortDateTime(ts, "en-US")).toBe("Nov 19, 03:04 PM");
		expect(shortDateTime(ts, "ko-KR")).toBe("11월 19일 오후 03:04");
	});
});


describe("pastLabel / messageTime", () => {
	const now = new Date(2026, 10, 22, 15, 0, 30).getTime(); // a Sunday, half a minute past 3 PM
	const at = (m: number, d: number, h: number, mi = 0, s = 0) => new Date(2026, m, d, h, mi, s).getTime();
	test("clock minutes: what the clocks beside it show, so every label turns over on the same minute", () => {
		expect(clockMinutes(at(10, 22, 14, 59, 59), at(10, 22, 15, 0, 1))).toBe(1);
		expect(clockMinutes(at(10, 22, 15, 0, 0), at(10, 22, 15, 0, 59))).toBe(0);
	});
	test("recent: 방금, minutes, then hours", () => {
		setLang("ko");
		const ko = (ts: number) => pastLabel(ts, now, { locale: "ko-KR" });
		expect(ko(at(10, 22, 15, 0, 0))).toBe("방금");
		expect(ko(now + 5_000)).toBe("방금"); // a server clock slightly ahead of this one
		expect(ko(at(10, 22, 14, 59, 59))).toBe("1분 전");
		expect(ko(at(10, 22, 14, 1))).toBe("59분 전");
		expect(ko(at(10, 22, 14, 0))).toBe("1시간 전");
		expect(ko(at(10, 22, 9, 1))).toBe("5시간 전");
	});
	test("older: the time today, then 어제, the weekday, the date, the year", () => {
		setLang("ko");
		const ko = (ts: number, time = true) => pastLabel(ts, now, { locale: "ko-KR", time });
		expect(ko(at(10, 22, 9, 0))).toBe("오전 9:00"); // 6 hours: the time
		expect(ko(at(10, 22, 0, 5))).toBe("오전 12:05");
		expect(ko(at(10, 21, 23, 30))).toBe("어제 오후 11:30");
		expect(ko(at(10, 21, 23, 30), false)).toBe("어제");
		expect(ko(at(10, 18, 14, 5))).toBe("수요일 오후 2:05");
		expect(ko(at(10, 16, 14, 5), false)).toBe("6일 전"); // a list column: days, not a bare weekday
		expect(ko(at(10, 15, 14, 5))).toBe("11월 15일"); // 7 days back: the date
		expect(ko(new Date(2025, 10, 15, 12).getTime())).toBe("2025년 11월 15일");
		expect(ko(new Date(2025, 10, 15, 12).getTime(), false)).toBe("2025년 11월");
		setLang("en");
		const en = (ts: number) => pastLabel(ts, now, { locale: "en-US" });
		expect(en(at(10, 22, 14, 48))).toBe("12m ago");
		expect(en(at(10, 21, 21, 30))).toBe("yesterday 9:30 PM");
		expect(en(at(10, 18, 14, 5))).toBe("Wed 2:05 PM");
		expect(en(at(10, 15, 14, 5))).toBe("Nov 15");
		setLang("ko");
	});
	test("a message: relative while recent, then the time of day (the day heading says which day)", () => {
		setLang("ko");
		expect(messageTime(at(10, 22, 14, 48), now, "ko-KR")).toBe("12분 전");
		expect(messageTime(at(10, 22, 12, 30), now, "ko-KR")).toBe("2시간 전");
		expect(messageTime(at(10, 22, 9, 0), now, "ko-KR")).toBe("오전 9:00");
		expect(messageTime(at(10, 18, 14, 5), now, "ko-KR")).toBe("오후 2:05"); // not "수 오후 2:05": the heading has it
	});
});

describe("pastChange / nextChange: the minute a label next reads differently", () => {
	const MIN = 60_000;
	const m = (ts: number) => Math.floor(ts / MIN);
	const ts = new Date(2026, 10, 22, 12, 0, 20).getTime();
	test("a past time: every minute for an hour, then on the hour, then never by the minute", () => {
		expect(pastChange(ts, ts + 5_000)).toBe(m(ts) + 1); // "방금" → "1분 전"
		expect(pastChange(ts, ts + 12 * MIN)).toBe(m(ts) + 13);
		expect(pastChange(ts, ts + 59 * MIN)).toBe(m(ts) + 60); // "59분 전" → "1시간 전"
		expect(pastChange(ts, ts + 61 * MIN)).toBe(m(ts) + 120); // "1시간 전" until "2시간 전"
		expect(pastChange(ts, ts + 5 * 60 * MIN + 30 * MIN)).toBe(m(ts) + 360); // "5시간 전" → the time of day
		expect(pastChange(ts, ts + 6 * 60 * MIN)).toBeNull(); // the day (or nothing) changes it from here
		expect(pastChange(ts, ts - 30_000)).toBe(m(ts) + 1); // a time ahead of this clock: "방금" until then
	});
	test("a future time: every minute within 6 hours, else when it comes within them", () => {
		const now = new Date(2026, 10, 22, 9, 0, 10).getTime();
		expect(nextChange(now + 12 * MIN, now)).toBe(m(now) + 1);
		expect(nextChange(now + 5 * 60 * MIN, now)).toBe(m(now) + 1);
		expect(nextChange(now + 9 * 60 * MIN, now)).toBe(m(now + 9 * 60 * MIN) - 359); // "오후 6:00" until "5시간 59분 후"
		expect(nextChange(now + 20_000, now)).toBeNull(); // "곧" stays until the run
	});
	test("waking at the given minute shows the next label, not the same one", () => {
		setLang("ko");
		for (const gone of [5_000, 12 * MIN, 59 * MIN + 30_000, 61 * MIN, 5 * 60 * MIN + 30 * MIN]) {
			const now = ts + gone;
			const wake = pastChange(ts, now)! * MIN;
			expect(pastLabel(ts, wake - 1, { locale: "ko-KR" })).toBe(pastLabel(ts, now, { locale: "ko-KR" })); // nothing changes before it
			expect(pastLabel(ts, wake, { locale: "ko-KR" })).not.toBe(pastLabel(ts, now, { locale: "ko-KR" }));
		}
	});
});
