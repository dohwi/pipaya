import { expect, test } from "bun:test";
import { applyMods, ctrlChar, keySequence, touchLines } from "../src/lib/terminal-keys";

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
	expect(applyMods("c", { ctrl: true, alt: false })).toEqual({ data: "\x03", used: true });
	expect(applyMods("x", { ctrl: false, alt: true })).toEqual({ data: "\x1bx", used: true });
	expect(applyMods("ls -la", { ctrl: true, alt: false })).toEqual({ data: "ls -la", used: false });
	expect(applyMods("\x1b[A", { ctrl: true, alt: false }).used).toBe(false);
	expect(applyMods("a", { ctrl: false, alt: false }).used).toBe(false);
});

test("touch scrolling keeps the remainder and flips direction", () => {
	expect(touchLines(0, 40, 16)).toEqual({ lines: -2, carry: 0.5 });
	expect(touchLines(0.5, 10, 16).lines).toBe(-1);
	expect(touchLines(0, -35, 16).lines).toBe(2);
	expect(touchLines(0, 5, 0)).toEqual({ lines: 0, carry: 0 });
});
