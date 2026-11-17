import { describe, expect, test } from "bun:test";
import { released } from "../src/lib/pointer";

describe("released", () => {
	test("a mouse or pen move with no button held ends the press", () => {
		expect(released({ pointerType: "mouse", buttons: 0 })).toBe(true);
		expect(released({ pointerType: "pen", buttons: 0 })).toBe(true);
	});
	test("a move with the button still held keeps the drag", () => {
		expect(released({ pointerType: "mouse", buttons: 1 })).toBe(false);
		expect(released({ pointerType: "pen", buttons: 1 })).toBe(false);
	});
	test("touch is never treated as released by a move", () => {
		expect(released({ pointerType: "touch", buttons: 0 })).toBe(false);
	});
});
