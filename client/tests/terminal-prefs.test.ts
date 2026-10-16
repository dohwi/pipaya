import { describe, expect, test } from "bun:test";
import { DEFAULT_TERMINAL, sanitizeTerminal } from "../src/lib/terminal-prefs";

describe("terminal preferences", () => {
	test("default font is Maple Mono", () => {
		expect(DEFAULT_TERMINAL.fontFamily.startsWith('"Maple Mono NGS NF"')).toBe(true);
		expect(sanitizeTerminal(null)).toEqual(DEFAULT_TERMINAL);
		// the previous default, stored untouched, moves to the new one
		expect(sanitizeTerminal({ fontFamily: '"Maple Mono"' }).fontFamily).toBe(DEFAULT_TERMINAL.fontFamily);
	});
	test("keeps valid values and clamps or replaces broken ones", () => {
		expect(sanitizeTerminal({ fontFamily: " Fira Code ", fontSize: 99, lineHeight: 0.2, cursorBlink: false, scrollback: -5 })).toEqual({
			fontFamily: "Fira Code", fontSize: 32, lineHeight: 1, cursorBlink: false, scrollback: 0,
		});
		expect(sanitizeTerminal({ fontFamily: "  ", fontSize: "x", cursorBlink: 1 })).toEqual(DEFAULT_TERMINAL);
	});
});
