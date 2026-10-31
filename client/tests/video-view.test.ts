import { expect, test } from "bun:test";
import { clock } from "../src/lib/video-view";

test("clock writes m:ss, and h:mm:ss from an hour on", () => {
	expect(clock(0)).toBe("0:00");
	expect(clock(5.9)).toBe("0:05");
	expect(clock(83)).toBe("1:23");
	expect(clock(3725)).toBe("1:02:05");
});

test("clock treats unknown durations as zero", () => {
	expect(clock(NaN)).toBe("0:00");
	expect(clock(Infinity)).toBe("0:00");
	expect(clock(-3)).toBe("0:00");
});
