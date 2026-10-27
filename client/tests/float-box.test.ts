import { describe, expect, test } from "bun:test";
import { KEY_STEP, MARGIN, clampBox, nudgeBox, type Box } from "../src/lib/extensions/float-box";

const none = { shift: false, alt: false, ctrl: false, meta: false };
const box: Box = { x: 100, y: 100, w: 300, h: 200, placed: 0 };

describe("floating window keyboard", () => {
	test("arrows move the title bar's window by one step", () => {
		expect(nudgeBox(box, "ArrowRight", none, "move")).toEqual({ ...box, x: 100 + KEY_STEP });
		expect(nudgeBox(box, "ArrowUp", none, "move")).toEqual({ ...box, y: 100 - KEY_STEP });
	});

	test("Shift and arrows resize it from the corner", () => {
		expect(nudgeBox(box, "ArrowDown", { ...none, shift: true }, "size")).toEqual({ ...box, h: 200 + KEY_STEP });
		expect(nudgeBox(box, "ArrowLeft", { ...none, shift: true }, "size")).toEqual({ ...box, w: 300 - KEY_STEP });
	});

	test("each handle ignores the other's keys, other modifiers and other keys", () => {
		expect(nudgeBox(box, "ArrowRight", { ...none, shift: true }, "move")).toBeNull(); // Shift is for the corner
		expect(nudgeBox(box, "ArrowRight", none, "size")).toBeNull();
		expect(nudgeBox(box, "ArrowRight", { ...none, ctrl: true }, "move")).toBeNull();
		expect(nudgeBox(box, "ArrowRight", { ...none, alt: true }, "move")).toBeNull();
		expect(nudgeBox(box, "a", none, "move")).toBeNull();
		expect(nudgeBox(box, "Enter", none, "move")).toBeNull();
	});

	test("a window is kept on screen and no smaller than it can use", () => {
		expect(clampBox({ ...box, x: -500, y: 5000 }, 1000, 800)).toMatchObject({ x: MARGIN, y: 800 - 200 - MARGIN });
		expect(clampBox({ ...box, w: 5000, h: 5000 }, 1000, 800)).toMatchObject({ w: 1000 - 2 * MARGIN, h: 800 - 2 * MARGIN });
		expect(clampBox({ ...box, w: 10, h: 10 }, 1000, 800)).toMatchObject({ w: 200, h: 120 });
	});

	test("pushing a window against the edge stays put instead of leaving the screen", () => {
		let b: Box = { ...box, x: MARGIN };
		for (let i = 0; i < 5; i++) b = clampBox(nudgeBox(b, "ArrowLeft", none, "move")!, 1000, 800);
		expect(b.x).toBe(MARGIN);
	});
});
