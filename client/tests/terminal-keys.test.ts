import { expect, test } from "bun:test";
import { applyMods, BAR_KEYS, ctrlChar, keySequence, touchLines } from "../src/lib/terminal-keys";

test("cursor keys follow application mode and modifiers", () => {
	expect(keySequence("up")).toBe("\x1b[A");
	expect(keySequence("up", {}, true)).toBe("\x1bOA");
	expect(keySequence("home", {}, true)).toBe("\x1b[H");
	expect(keySequence("left", { ctrl: true })).toBe("\x1b[1;5D");
	expect(keySequence("right", { alt: true, ctrl: true })).toBe("\x1b[1;7C");
	expect(keySequence("pgup")).toBe("\x1b[5~");
	expect(keySequence("del", { ctrl: true })).toBe("\x1b[3;5~");
	expect(keySequence("tab")).toBe("\t");
	expect(keySequence("esc")).toBe("\x1b");
});

test("ctrl characters", () => {
	expect(ctrlChar("c")).toBe("\x03");
	expect(ctrlChar("C")).toBe("\x03");
	expect(ctrlChar("[")).toBe("\x1b");
	expect(ctrlChar("1")).toBeNull();
});

test("sticky modifiers apply to one typed character only", () => {
	expect(applyMods("c", { ctrl: true, alt: false, shift: false })).toEqual({ data: "\x03", used: true });
	expect(applyMods("x", { ctrl: false, alt: true, shift: false })).toEqual({ data: "\x1bx", used: true });
	expect(applyMods("ls -la", { ctrl: true, alt: false, shift: false })).toEqual({ data: "ls -la", used: false });
	expect(applyMods("\x1b[A", { ctrl: true, alt: false, shift: false }).used).toBe(false);
	expect(applyMods("a", { ctrl: false, alt: false, shift: false }).used).toBe(false);
});

test("touch scrolling keeps the remainder and flips direction", () => {
	expect(touchLines(0, 40, 16)).toEqual({ lines: -2, carry: 0.5 });
	expect(touchLines(0.5, 10, 16).lines).toBe(-1);
	expect(touchLines(0, -35, 16).lines).toBe(2);
	expect(touchLines(0, 5, 0)).toEqual({ lines: 0, carry: 0 });
});

test("function keys, Shift+Tab and shift letters", () => {
	expect(keySequence("f1")).toBe("\x1bOP");
	expect(keySequence("f5")).toBe("\x1b[15~");
	expect(keySequence("f12")).toBe("\x1b[24~");
	expect(keySequence("f1", { ctrl: true })).toBe("\x1b[1;5P");
	expect(keySequence("tab", { shift: true })).toBe("\x1b[Z");
	expect(keySequence("ins")).toBe("\x1b[2~");
	expect(applyMods("a", { ctrl: false, alt: false, shift: true })).toEqual({ data: "A", used: true });
});

test("bar keys have unique ids and every key sends something", () => {
	const ids = BAR_KEYS.map((k) => k.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (const k of BAR_KEYS) expect(!!k.send || !!k.text).toBe(true);
	expect(BAR_KEYS.length).toBeGreaterThan(60);
});
