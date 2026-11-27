import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { setLang } from "../src/lib/i18n";
import { MAX_PANES, MAX_RATIO, MIN_RATIO, measure, pair, pane, panesOf, setRatio, splitAt, type Layout } from "../src/lib/layout";
import { findPreset, layoutPaletteSpec, layoutsMatch, matchPreset, presetsFor, recommendedPreset, type LayoutPresetId } from "../src/lib/layout-presets";

const SERVER_MAX_DEPTH = 8;

function depthOf(l: Layout): number {
	return l.type === "pane" ? 0 : 1 + Math.max(depthOf(l.a), depthOf(l.b));
}

function allRatiosValid(l: Layout): boolean {
	return l.type === "pane" || (l.ratio >= MIN_RATIO && l.ratio <= MAX_RATIO && allRatiosValid(l.a) && allRatiosValid(l.b));
}

beforeEach(() => {
	setLang("ko");
});
afterAll(() => {
	setLang("en");
});

describe("layout presets", () => {
	test("every pane count from 2 to MAX_PANES has valid, unique presets with one recommended default first", () => {
		for (let n = 2; n <= MAX_PANES; n++) {
			const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
			const presets = presetsFor(ids);
			expect(presets.length).toBeGreaterThanOrEqual(2);
			expect(presets[0]!.recommended).toBe(true);
			expect(presets.filter((p) => p.recommended)).toHaveLength(1);
			expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);

			for (const p of presets) {
				expect(panesOf(p.layout)).toEqual(ids);
				expect(depthOf(p.layout)).toBeLessThanOrEqual(SERVER_MAX_DEPTH);
				expect(allRatiosValid(p.layout)).toBe(true);
				expect(p.boxes).toHaveLength(n);
				const totalArea = p.boxes.reduce((sum, b) => sum + b.w * b.h, 0);
				expect(totalArea).toBeCloseTo(1, 6);
				expect(matchPreset(p.layout)?.id).toBe(p.id);
			}
		}
	});

	test("recommends natural splits per pane count (2-col, 3-col, 2x2 grid, 3+2, 3x2, 4+3, 4x2)", () => {
		const rec = (n: number) => presetsFor(Array.from({ length: n }, (_, i) => `p${i}`))[0]!;
		expect(rec(2).id).toBe("columns");
		expect(rec(3).id).toBe("columns");
		expect(rec(3).label).toBe("좌우 3분할");
		// 3-split gives every pane an equal 1/3 width and full height
		for (const b of rec(3).boxes) {
			expect(b.w).toBeCloseTo(1 / 3, 6);
			expect(b.h).toBeCloseTo(1, 6);
		}
		expect(rec(4).id).toBe("grid");
		expect(rec(4).label).toBe("2×2 격자");
		for (const b of rec(4).boxes) {
			expect(b.w).toBeCloseTo(0.5, 6);
			expect(b.h).toBeCloseTo(0.5, 6);
		}
		expect(rec(5).id).toBe("grid");
		expect(rec(5).label).toBe("격자 (3 + 2)");
		expect(rec(6).id).toBe("grid");
		expect(rec(6).label).toBe("3×2 격자");
		expect(rec(7).id).toBe("grid");
		expect(rec(7).label).toBe("격자 (4 + 3)");
		expect(rec(8).id).toBe("grid");
		expect(rec(8).label).toBe("4×2 격자");
	});

	test("geometrically matches equivalent splits regardless of binary tree nesting", () => {
		// Left-nested 3-column split: (a | b) | c with ratios 2/3 and 1/2
		const leftNested: Layout = {
			type: "split",
			dir: "row",
			ratio: 2 / 3,
			a: { type: "split", dir: "row", ratio: 0.5, a: pane("a"), b: pane("b") },
			b: pane("c"),
		};
		expect(matchPreset(leftNested)?.id).toBe("columns");

		// Unevenly dragged split does not match a preset
		const uneven = setRatio(leftNested, [], 0.8);
		expect(matchPreset(uneven)).toBeNull();

		// Same geometry but different session order does not match
		const swapped = pair("b", "a", "right");
		expect(layoutsMatch(pair("a", "b", "right"), swapped)).toBe(false);
	});

	test("edge cases: invalid counts, empty or duplicate ids, unknown preset id, and English labels", () => {
		expect(presetsFor([])).toEqual([]);
		expect(presetsFor(["only"])).toEqual([]);
		expect(presetsFor(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toEqual([]);
		expect(recommendedPreset(pane("only"))).toBeNull();

		// Empty strings and duplicates are rejected so a malformed layout never silently drops panes
		expect(presetsFor(["a", "", "b"])).toEqual([]);
		expect(presetsFor(["a", "a", "b"])).toEqual([]);

		const two = pair("a", "b", "right");
		expect(findPreset(two, "rows")?.id).toBe("rows");
		expect(findPreset(two, "grid")).toBeNull();

		// English translation renders without unreplaced placeholders
		setLang("en");
		const enThree = presetsFor(["a", "b", "c"]);
		expect(enThree[0]!.label).toBe("Horizontal 3-split");
		expect(enThree.every((p) => !p.label.includes("{") && !p.desc.includes("{"))).toBe(true);
		expect(measure(enThree[1]!.layout).panes.find((p) => p.id === "a")?.w).toBeCloseTo(0.5, 6);
	});

	test("layoutPaletteSpec binds arrangePanes as closeShortcut, marks the current/recommended preset, and forwards selection", () => {
		const picked: LayoutPresetId[] = [];
		const matchedLayout = findPreset(splitAt(pair("a", "b", "right"), "b", "c", "bottom"), "main-left")!.layout;
		const spec = layoutPaletteSpec({ name: "작업 그룹", layout: matchedLayout }, (id) => {
			picked.push(id);
		});
		expect(spec.closeShortcut).toBe("arrangePanes");
		expect(spec.title).toBe("'작업 그룹' 레이아웃 선택");
		expect(spec.items.map((it) => it.id)).toEqual(["columns", "main-left", "main-top", "rows"]);
		expect(spec.items[0]!.tag).toBe("추천");
		expect(spec.items.slice(1).every((it) => it.tag === undefined)).toBe(true);
		expect(spec.items.map((it) => !!it.current)).toEqual([false, true, false, false]);
		expect(spec.items.every((it) => (it.preview?.length ?? 0) === 3)).toBe(true);

		spec.onpick(spec.items[2]!);
		expect(picked).toEqual(["main-top"]);

		// Irregular layout: no item is marked current, so the palette starts at index 0 (recommended)
		const irregular = setRatio(splitAt(pair("a", "b", "right"), "b", "c", "bottom"), [], 0.25);
		const irregularSpec = layoutPaletteSpec({ name: "Irregular", layout: irregular }, () => {});
		expect(irregularSpec.items.every((it) => !it.current)).toBe(true);

		// Single pane: empty items list with fallback message
		const singleSpec = layoutPaletteSpec({ name: "Solo", layout: pane("only") }, () => {});
		expect(singleSpec.items).toEqual([]);
		expect(singleSpec.empty).toBeTruthy();
	});
});
