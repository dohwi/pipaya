import { describe, expect, test } from "bun:test";
import { layoutToastStack, STACK_DEFAULT_HEIGHT, STACK_GAP, STACK_PEEK, STACK_VISIBLE, stageToastBox } from "../src/lib/toast-stack";

describe("layoutToastStack", () => {
	test("returns empty layout for zero toasts", () => {
		expect(layoutToastStack([], {}, false)).toEqual({ height: 0, items: [] });
		expect(layoutToastStack([], {}, true, "bottom")).toEqual({ height: 0, items: [] });
	});

	test("single toast ignores expanded and uses measured or default height", () => {
		const a = layoutToastStack([1], {}, false);
		const b = layoutToastStack([1], {}, true);
		expect(a).toEqual(b);
		expect(a.height).toBe(STACK_DEFAULT_HEIGHT);
		expect(a.items).toEqual([{ id: 1, index: 0, y: 0, scale: 1, opacity: 1, z: STACK_VISIBLE, hidden: false, behind: false }]);

		const measured = layoutToastStack([1], { 1: 60 }, false);
		expect(measured.height).toBe(60);
	});

	test("collapsed stack shows up to STACK_VISIBLE cards stepping down by STACK_PEEK and hides older ones", () => {
		const res = layoutToastStack([5, 4, 3, 2, 1], { 5: 48, 4: 80, 3: 64 }, false, "top");
		expect(res.height).toBe(48 + 2 * STACK_PEEK);
		expect(res.items.map((x) => [x.id, x.y, x.scale, x.hidden, x.behind, x.z])).toEqual([
			[5, 0, 1, false, false, 3],
			[4, 8, 0.95, false, true, 2],
			[3, 16, 0.9, false, true, 1],
			[2, 16, 0.85, true, true, 0],
			[1, 16, 0.84, true, true, 0],
		]);
		expect(res.items[3]!.opacity).toBe(0);
		expect(res.items[4]!.opacity).toBe(0);
	});

	test("expanded stack lists every toast at full scale with STACK_GAP between measured heights", () => {
		const res = layoutToastStack([3, 2, 1], { 3: 44, 2: 68, 1: 44 }, true, "top");
		expect(res.height).toBe(44 + STACK_GAP + 68 + STACK_GAP + 44);
		expect(res.items.map((x) => [x.id, x.y, x.scale, x.opacity, x.hidden, x.behind])).toEqual([
			[3, 0, 1, 1, false, false],
			[2, 44 + STACK_GAP, 1, 1, false, false],
			[1, 44 + STACK_GAP + 68 + STACK_GAP, 1, 1, false, false],
		]);
	});

	test("bottom anchor mirrors Y offsets upward for both collapsed and expanded states", () => {
		const collapsed = layoutToastStack([3, 2, 1], { 3: 44 }, false, "bottom");
		expect(collapsed.items.map((x) => x.y)).toEqual([0, -STACK_PEEK, -2 * STACK_PEEK]);

		const expanded = layoutToastStack([3, 2, 1], { 3: 44, 2: 52, 1: 40 }, true, "bottom");
		expect(expanded.items.map((x) => x.y)).toEqual([0, -(44 + STACK_GAP), -(44 + STACK_GAP + 52 + STACK_GAP)]);
		expect(expanded.height).toBe(44 + STACK_GAP + 52 + STACK_GAP + 40);
	});
});

describe("stageToastBox", () => {
	test("places tray directly below stage top or any taller overlay strips", () => {
		expect(stageToastBox({ left: 288, width: 1152, top: 83 })).toEqual({ left: 288, width: 1152, top: 83 });
		expect(stageToastBox({ left: 288, width: 1152, top: 83 }, [60, 127, 171])).toEqual({ left: 288, width: 1152, top: 171 });
		expect(stageToastBox({ left: 288, width: 1152, top: 83 }, [40])).toEqual({ left: 288, width: 1152, top: 83 });
	});

	test("divides out CSS --ui-zoom so fixed coordinates are not scaled twice", () => {
		expect(stageToastBox({ left: 345.6, width: 1094.4, top: 99.6 }, [152.4], 1.2)).toEqual({
			left: 288,
			width: 912,
			top: 127,
		});
		expect(stageToastBox({ left: 230.4, width: 1209.6, top: 66.4 }, [], 0.8)).toEqual({
			left: 288,
			width: 1512,
			top: 83,
		});
	});

	test("falls back to zoom 1 for falsy, zero, negative, or non-finite values and ignores non-finite bottoms", () => {
		const rect = { left: 288, width: 1152, top: 83 };
		expect(stageToastBox(rect, [], 0)).toEqual(rect);
		expect(stageToastBox(rect, [], -1)).toEqual(rect);
		expect(stageToastBox(rect, [], Number.NaN)).toEqual(rect);
		expect(stageToastBox(rect, [], Number.POSITIVE_INFINITY)).toEqual(rect);
		expect(stageToastBox(rect, [Number.NaN, Number.POSITIVE_INFINITY, 120], 1)).toEqual({
			left: 288,
			width: 1152,
			top: 120,
		});
	});
});
