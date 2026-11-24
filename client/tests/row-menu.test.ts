import { describe, expect, test } from "bun:test";
import { anchorShifted, hoverMenuZone, pointInRect } from "../src/lib/row-menu";

const ANCHOR = { left: 246, right: 266, top: 160, bottom: 180 };
const MENU_RIGHT = { left: 272, right: 468, top: 156, bottom: 238 };
const MENU_LEFT = { left: 44, right: 240, top: 156, bottom: 238 };

describe("row-menu geometry", () => {
	test("pointInRect handles boundaries and empty rects", () => {
		expect(pointInRect({ x: 246, y: 160 }, ANCHOR)).toBe(true);
		expect(pointInRect({ x: 266, y: 180 }, ANCHOR)).toBe(true);
		expect(pointInRect({ x: 267, y: 170 }, ANCHOR)).toBe(false);
		expect(pointInRect({ x: 0, y: 0 }, { left: 0, right: 0, top: 0, bottom: 0 })).toBe(false);
	});

	test("hoverMenuZone distinguishes inside, gap corridor, and outside for right and flipped-left menus", () => {
		// inside anchor and menu
		expect(hoverMenuZone({ x: 256, y: 170 }, ANCHOR, MENU_RIGHT)).toBe("inside");
		expect(hoverMenuZone({ x: 320, y: 190 }, ANCHOR, MENU_RIGHT)).toBe("inside");
		// 6px gap between anchor and menu stays in corridor (grace period)
		expect(hoverMenuZone({ x: 269, y: 170 }, ANCHOR, MENU_RIGHT)).toBe("corridor");
		// slightly past edge stays in corridor
		expect(hoverMenuZone({ x: 480, y: 170 }, ANCHOR, MENU_RIGHT)).toBe("corridor");
		// moved into the main context pane -> outside (closes immediately)
		expect(hoverMenuZone({ x: 600, y: 300 }, ANCHOR, MENU_RIGHT)).toBe("outside");
		// flipped-left menu works symmetrically
		expect(hoverMenuZone({ x: 243, y: 170 }, ANCHOR, MENU_LEFT)).toBe("corridor");
		expect(hoverMenuZone({ x: 100, y: 190 }, ANCHOR, MENU_LEFT)).toBe("inside");
		expect(hoverMenuZone({ x: 500, y: 190 }, ANCHOR, MENU_LEFT)).toBe("outside");
		// missing/empty rects count as outside
		expect(hoverMenuZone({ x: 256, y: 170 }, null, null)).toBe("outside");
		expect(hoverMenuZone({ x: 0, y: 0 }, { left: 0, right: 0, top: 0, bottom: 0 }, null)).toBe("outside");
	});

	test("anchorShifted allows 2px jitter and flags real movement", () => {
		expect(anchorShifted({ top: 100, left: 246 }, { top: 102, left: 244 })).toBe(false);
		expect(anchorShifted({ top: 100, left: 246 }, { top: 103, left: 246 })).toBe(true);
		expect(anchorShifted({ top: 100, left: 246 }, { top: 100, left: 249 })).toBe(true);
	});
});
