import { afterEach, describe, expect, test } from "bun:test";
import { ms, reduced, setReducedMotionOverride } from "../src/lib/motion";
import {
	parseMentionHover,
	parseReducedMotionPref,
	parseRunningEnterMode,
	parseSendKeyMode,
	parseSessionOpenMode,
	resolveSessionOpen,
} from "../src/lib/ux-prefs";

afterEach(() => {
	setReducedMotionOverride(false);
});

describe("ux-prefs parsers", () => {
	test("parseSessionOpenMode accepts peek/open and falls back on invalid or falsy inputs", () => {
		expect(parseSessionOpenMode("peek", "open")).toBe("peek");
		expect(parseSessionOpenMode("open", "peek")).toBe("open");
		for (const bad of [null, undefined, "", 0, false, true, "modal", "direct", {}]) {
			expect(parseSessionOpenMode(bad, "peek")).toBe("peek");
			expect(parseSessionOpenMode(bad, "open")).toBe("open");
		}
	});

	test("parseSendKeyMode accepts mod-enter and defaults everything else to enter", () => {
		expect(parseSendKeyMode("mod-enter")).toBe("mod-enter");
		for (const bad of ["enter", null, undefined, "", 0, false, "ctrl-enter"]) {
			expect(parseSendKeyMode(bad)).toBe("enter");
		}
	});

	test("parseRunningEnterMode accepts queue and defaults everything else to steer", () => {
		expect(parseRunningEnterMode("queue")).toBe("queue");
		for (const bad of ["steer", null, undefined, "", 0, false, "followup"]) {
			expect(parseRunningEnterMode(bad)).toBe("steer");
		}
	});

	test("parseReducedMotionPref accepts on and defaults everything else to system", () => {
		expect(parseReducedMotionPref("on")).toBe("on");
		for (const bad of ["system", "off", null, undefined, "", 0, false, true]) {
			expect(parseReducedMotionPref(bad)).toBe("system");
		}
	});

	test("parseMentionHover is true unless explicitly false", () => {
		expect(parseMentionHover(false)).toBe(false);
		for (const v of [true, null, undefined, "", 0, "false"]) {
			expect(parseMentionHover(v)).toBe(true);
		}
	});
});

describe("resolveSessionOpen", () => {
	test("peek mode peeks on plain click and opens on modifier click", () => {
		expect(resolveSessionOpen("peek", false)).toBe("peek");
		expect(resolveSessionOpen("peek", true)).toBe("open");
	});

	test("open mode opens on plain click and peeks on modifier click", () => {
		expect(resolveSessionOpen("open", false)).toBe("open");
		expect(resolveSessionOpen("open", true)).toBe("peek");
	});

	test("closed sessions stay read-only peek on plain click even in open mode, and resume only on modifier click", () => {
		expect(resolveSessionOpen("open", false, { closed: true })).toBe("peek");
		expect(resolveSessionOpen("open", true, { closed: true })).toBe("open");
		expect(resolveSessionOpen("peek", false, { closed: true })).toBe("peek");
		expect(resolveSessionOpen("peek", true, { closed: true })).toBe("open");
	});
});

describe("reduced motion override", () => {
	test("setReducedMotionOverride forces reduced() true and ms() to 0", () => {
		setReducedMotionOverride(true);
		expect(reduced()).toBe(true);
		expect(ms("fast")).toBe(0);
		expect(ms("normal")).toBe(0);
		setReducedMotionOverride(false);
		expect(reduced()).toBe(false);
		expect(ms("fast")).toBeGreaterThan(0);
	});
});
