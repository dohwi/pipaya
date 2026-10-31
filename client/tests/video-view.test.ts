import { expect, test } from "bun:test";
import { clock, nextSpeed, speedLabel } from "../src/lib/video-view";

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

test("the speed button steps 1× → 1.25× → 1.5× → 2× → 0.5× and wraps to 1×", () => {
	const seen = [1];
	for (let i = 0; i < 5; i++) seen.push(nextSpeed(seen[seen.length - 1]));
	expect(seen).toEqual([1, 1.25, 1.5, 2, 0.5, 1]);
	expect(nextSpeed(3)).toBe(1);
});

test("speedLabel writes the rate with a ×", () => {
	expect(speedLabel(1)).toBe("1×");
	expect(speedLabel(1.25)).toBe("1.25×");
});
