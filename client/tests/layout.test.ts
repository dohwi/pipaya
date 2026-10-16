import { describe, expect, test } from "bun:test";
import { alignPosition, isolate, linkedDividers, positionOf, moveDividers, snapPosition, measure, MAX_RATIO, MIN_RATIO, pair, pane, panesOf, place, remove, replaceSession, setRatio, splitAt, swap, worthKeeping, zoneAt, type Layout } from "../src/lib/layout";

const split = (a: Layout, b: Layout, dir: "row" | "col" = "row", ratio = 0.5): Layout => ({ type: "split", dir, ratio, a, b });

describe("layout tree", () => {
	test("splitAt puts the newcomer on the chosen side", () => {
		expect(splitAt(pane("a"), "a", "b", "right")).toEqual(split(pane("a"), pane("b")));
		expect(splitAt(pane("a"), "a", "b", "left")).toEqual(split(pane("b"), pane("a")));
		expect(splitAt(pane("a"), "a", "b", "top")).toEqual(split(pane("b"), pane("a"), "col"));
		expect(splitAt(pane("a"), "a", "b", "bottom")).toEqual(split(pane("a"), pane("b"), "col"));
	});

	test("splitAt only splits the target pane", () => {
		const l = splitAt(pair("a", "b"), "b", "c", "bottom");
		expect(l).toEqual(split(pane("a"), split(pane("b"), pane("c"), "col")));
		expect(panesOf(l)).toEqual(["a", "b", "c"]);
	});

	test("remove gives the freed space to the sibling", () => {
		const l = split(pane("a"), split(pane("b"), pane("c"), "col"));
		expect(remove(l, "b")).toEqual(split(pane("a"), pane("c")));
		expect(remove(l, "a")).toEqual(split(pane("b"), pane("c"), "col"));
		expect(remove(pane("a"), "a")).toBeNull();
		expect(remove(l, "zzz")).toBe(l);
	});

	test("swap exchanges two panes and keeps the shape", () => {
		const l = split(pane("a"), split(pane("b"), pane("c"), "col"), "row", 0.3);
		expect(swap(l, "a", "c")).toEqual(split(pane("c"), split(pane("b"), pane("a"), "col"), "row", 0.3));
	});

	test("place: edge drop of a session already in the layout moves it", () => {
		const l = split(pane("a"), split(pane("b"), pane("c"), "col"));
		expect(panesOf(place(l, "a", "c", "bottom")!)).toEqual(["b", "c", "a"]);
		expect(place(l, "a", "a", "left")).toBeNull();
		expect(place(l, "x", "nope", "left")).toBeNull();
	});

	test("place: an edge drop of an outsider adds it beside the target", () => {
		const l = pair("a", "b");
		expect(panesOf(place(l, "n", "a", "top")!)).toEqual(["n", "a", "b"]);
		expect(panesOf(place(l, "n", "b", "left")!)).toEqual(["a", "n", "b"]);
		expect(place(l, "n", "a", "bottom")).toEqual({ type: "split", dir: "row", ratio: 0.5, a: { type: "split", dir: "col", ratio: 0.5, a: pane("a"), b: pane("n") }, b: pane("b") });
	});

	test("place: moving the only other pane out keeps a valid tree", () => {
		expect(place(pair("a", "b"), "b", "a", "right")).toEqual(pair("a", "b"));
	});

	test("setRatio addresses a node by path and clamps", () => {
		const l = split(pane("a"), split(pane("b"), pane("c"), "col"));
		expect((setRatio(l, [], 0.7) as { ratio: number }).ratio).toBe(0.7);
		const inner = setRatio(l, ["b"], 0.2) as Extract<Layout, { type: "split" }>;
		expect((inner.b as { ratio: number }).ratio).toBe(0.2);
		expect(inner.ratio).toBe(0.5);
		expect((setRatio(l, [], 5) as { ratio: number }).ratio).toBe(MAX_RATIO);
		expect((setRatio(l, [], -1) as { ratio: number }).ratio).toBe(MIN_RATIO);
		expect(setRatio(l, ["a", "a"], 0.3)).toEqual(l);
	});

	test("worthKeeping: a group needs two sessions", () => {
		expect(worthKeeping(null)).toBe(false);
		expect(worthKeeping(pane("a"))).toBe(false);
		expect(worthKeeping(pair("a", "b"))).toBe(true);
	});

	test("zoneAt: the nearest side wins everywhere, there is no middle", () => {
		expect(zoneAt(0.4, 0.3)).toBe("top"); // near the middle it is still a side
		expect(zoneAt(0.6, 0.45)).toBe("right");
		for (let x = 0; x <= 1; x += 0.05) for (let y = 0; y <= 1; y += 0.05) expect(["left", "right", "top", "bottom"]).toContain(zoneAt(x, y));
		expect(zoneAt(0.05, 0.5)).toBe("left");
		expect(zoneAt(0.95, 0.5)).toBe("right");
		expect(zoneAt(0.5, 0.05)).toBe("top");
		expect(zoneAt(0.5, 0.95)).toBe("bottom");
		expect(zoneAt(0.05, 0.2)).toBe("left"); // corners go to the nearer side
	});
});

import { append } from "../src/lib/layout";

describe("layout geometry", () => {
	test("append adds a pane beside the whole layout", () => {
		const l = append(pair("a", "b"), "c");
		expect(panesOf(l)).toEqual(["a", "b", "c"]);
		expect((l as { ratio: number }).ratio).toBeCloseTo(2 / 3);
	});

	test("measure tiles the area without gaps or overlap", () => {
		const l = split(pane("a"), split(pane("b"), pane("c"), "col", 0.25), "row", 0.4);
		const { panes, dividers } = measure(l);
		const by = Object.fromEntries(panes.map((p) => [p.id, p]));
		expect(by.a).toEqual({ id: "a", x: 0, y: 0, w: 0.4, h: 1 });
		expect(by.b!.x).toBeCloseTo(0.4);
		expect(by.b!.h).toBeCloseTo(0.25);
		expect(by.c!.y).toBeCloseTo(0.25);
		expect(panes.reduce((n, p) => n + p.w * p.h, 0)).toBeCloseTo(1);
		expect(dividers.map((d) => d.path.join(""))).toEqual(["", "b"]);
		expect(dividers[1]!.area.x).toBeCloseTo(0.4);
	});
});

describe("isolate", () => {
	const boxes = (l: Layout) => Object.fromEntries(measure(l).panes.map((p) => [p.id, { x: p.x, y: p.y, w: p.w, h: p.h }]));
	const expectSameBoxes = (x: Layout, y: Layout) => {
		const bx = boxes(x), by = boxes(y);
		expect(Object.keys(bx).sort()).toEqual(Object.keys(by).sort());
		for (const k of Object.keys(bx)) for (const f of ["x", "y", "w", "h"] as const) expect(bx[k]![f]).toBeCloseTo(by[k]![f]);
	};
	/** Drag the piece around `at` to `pos` and return the pane boxes. */
	const drag = (l: Layout, path: string[], at: number, pos: number) => {
		const r = isolate(l, path as ("a" | "b")[], at)!;
		expect(r).not.toBeNull();
		expectSameBoxes(r.layout, l); // grabbing alone changes nothing on screen
		return { ...r, after: boxes(moveDividers(r.layout, [r.path], pos)) };
	};
	const row3 = (a: string, b: string, c: string): Layout => split(pane(a), split(pane(b), pane(c), "row", 0.5), "row", 1 / 3);
	const col3 = (a: string, b: string, c: string): Layout => split(pane(a), split(pane(b), pane(c), "col", 0.5), "col", 1 / 3);

	test("2x2 built as columns: each half of the vertical line moves alone", () => {
		const grid = split(split(pane("a"), pane("b"), "col", 0.5), split(pane("c"), pane("d"), "col", 0.5), "row", 0.5);
		const top = drag(grid, [], 0.2, 0.8);
		expect(top.span).toEqual([0, 0.5]);
		expect(top.after.a!.w).toBeCloseTo(0.8);
		expect(top.after.b!.w).toBeCloseTo(0.5);
		const bottom = drag(grid, [], 0.7, 0.3);
		expect(bottom.after.b!.w).toBeCloseTo(0.3);
		expect(bottom.after.a!.w).toBeCloseTo(0.5);
	});

	test("3x2 as two rows of three: each third of the horizontal line moves alone", () => {
		const l = split(row3("A", "B", "C"), row3("D", "E", "F"), "col", 0.5);
		for (const [at, mine, others] of [[0.1, ["A"], ["B", "C"]], [0.5, ["B"], ["A", "C"]], [0.9, ["C"], ["A", "B"]]] as const) {
			const { after } = drag(l, [], at, 0.7);
			for (const id of mine) expect(after[id]!.h).toBeCloseTo(0.7);
			for (const id of others) expect(after[id]!.h).toBeCloseTo(0.5);
			expect(Object.values(after).reduce((n, p) => n + p.w * p.h, 0)).toBeCloseTo(1);
		}
	});

	test("3x2 as two rows of three: a vertical line inside a row already moves alone", () => {
		const l = split(row3("A", "B", "C"), row3("D", "E", "F"), "col", 0.5);
		expect(isolate(l, ["a"], 0.2)).toBeNull();
		expect(isolate(l, ["b", "b"], 0.8)).toBeNull();
	});

	test("two columns of three: each third of the vertical line moves alone", () => {
		const l = split(col3("A", "B", "C"), col3("D", "E", "F"), "row", 0.5);
		const { after } = drag(l, [], 0.5, 0.3);
		expect(after.B!.w).toBeCloseTo(0.3);
		expect(after.E!.x).toBeCloseTo(0.3);
		expect(after.A!.w).toBeCloseTo(0.5);
		expect(after.C!.w).toBeCloseTo(0.5);
	});

	test("a T junction is not a cross: the line moves as a whole", () => {
		// left: one pane; right: two stacked -> the horizontal line on the right ends at the vertical one
		const t = split(pane("a"), split(pane("b"), pane("c"), "col"), "row");
		expect(isolate(t, [], 0.2)).toBeNull();
		// rows that do not line up: no cross
		const off = split(split(pane("A"), pane("B"), "row", 0.3), split(pane("C"), pane("D"), "row", 0.6), "col");
		expect(isolate(off, [], 0.2)).toBeNull();
	});

	test("lines meeting only on part of the line cut it there and leave the rest whole", () => {
		// top: A | (B | C) at 1/3, 2/3; bottom: D | E at 1/3 -> only x = 1/3 is a cross
		const l = split(row3("A", "B", "C"), split(pane("D"), pane("E"), "row", 1 / 3), "col", 0.5);
		const left = drag(l, [], 0.1, 0.6);
		expect(left.span[1]).toBeCloseTo(1 / 3);
		expect(left.after.A!.h).toBeCloseTo(0.6);
		expect(left.after.B!.h).toBeCloseTo(0.5);
		const right = drag(l, [], 0.8, 0.6);
		expect(right.span[0]).toBeCloseTo(1 / 3);
		expect(right.after.B!.h).toBeCloseTo(0.6);
		expect(right.after.C!.h).toBeCloseTo(0.6);
		expect(right.after.A!.h).toBeCloseTo(0.5);
	});

	test("an isolated piece can be cut again after the tree turned", () => {
		const l = split(row3("A", "B", "C"), row3("D", "E", "F"), "col", 0.5);
		const r = isolate(l, [], 0.5)!;
		// now three columns; the vertical line between A/D and B/E is crossed by y = 0.5
		const v = measure(r.layout).dividers.find((d) => d.dir === "row" && Math.abs(positionOf(d) - 1 / 3) < 1e-6)!;
		const { after } = drag(r.layout, v.path, 0.2, 0.2);
		expect(after.A!.w).toBeCloseTo(0.2);
		expect(after.D!.w).toBeCloseTo(1 / 3);
	});

	test("nothing to separate for a plain split", () => {
		expect(isolate(pair("a", "b"), [], 0.5)).toBeNull();
	});
});

describe("replaceSession", () => {
	test("swaps one pane's session and keeps the shape, ratios and the other panes", () => {
		const l = setRatio(splitAt(pair("a", "b", "right"), "b", "c", "bottom"), [], 0.3);
		const next = replaceSession(l, "b", "x");
		expect(panesOf(next)).toEqual(["a", "x", "c"]);
		expect(replaceSession(next, "x", "b")).toEqual(l); // swapping back restores the original, shape and ratios included
		expect((next as any).ratio).toBe(0.3);
	});
	test("an unknown session leaves the layout unchanged", () => {
		const l = pair("a", "b", "right");
		expect(replaceSession(l, "zzz", "x")).toEqual(l);
	});
});

describe("linked dividers", () => {
	const grid = (r1 = 0.3, r2 = 0.6): Layout => split(split(pane("A"), pane("B"), "row", r1), split(pane("C"), pane("D"), "row", r2), "col");
	const xs = (l: Layout) => measure(l).dividers.filter((d) => d.dir === "row").map((d) => d.area.x + d.area.w * d.ratio);

	test("aligned segments link up, misaligned ones do not", () => {
		expect(linkedDividers(grid(0.5, 0.5), ["a"]).map((p) => p.join(""))).toEqual(["a", "b"]);
		expect(linkedDividers(grid(0.3, 0.6), ["a"])).toEqual([["a"]]);
	});

	test("horizontal lines link the same way (A/C | B/D built as rows of columns)", () => {
		const cols = (r1: number, r2: number): Layout => split(split(pane("A"), pane("C"), "col", r1), split(pane("B"), pane("D"), "col", r2), "row");
		expect(linkedDividers(cols(0.5, 0.5), ["a"]).map((p) => p.join(""))).toEqual(["a", "b"]);
		expect(linkedDividers(cols(0.3, 0.6), ["a"])).toEqual([["a"]]);
		const out = moveDividers(cols(0.5, 0.5), [["a"], ["b"]], 0.4);
		const ys = measure(out).dividers.filter((d) => d.dir === "col").map((d) => d.area.y + d.area.h * d.ratio);
		expect(ys[0]).toBeCloseTo(0.4);
		expect(ys[1]).toBeCloseTo(0.4);
	});

	test("moveDividers puts separate segments on one line", () => {
		const out = moveDividers(grid(), [["a"], ["b"]], 0.45);
		expect(xs(out)[0]).toBeCloseTo(0.45);
		expect(xs(out)[1]).toBeCloseTo(0.45);
	});

	test("moveDividers clamps and handles a shared node", () => {
		const out = moveDividers(grid(), [["a"], ["b"]], 0.99);
		expect(xs(out)[0]).toBeCloseTo(MAX_RATIO);
		const shared = split(split(pane("A"), pane("C"), "col"), split(pane("B"), pane("D"), "col"), "row");
		expect(measure(moveDividers(shared, [[]], 0.7)).dividers[0]!.ratio).toBeCloseTo(0.7);
	});

	test("snapPosition snaps to centre and other dividers", () => {
		expect(snapPosition(grid(), [["a"]], 0.51)).toBeCloseTo(0.5);
		expect(snapPosition(grid(), [["a"]], 0.595)).toBeCloseTo(0.6);
		expect(snapPosition(grid(), [["a"]], 0.42)).toBeCloseTo(0.42);
	});
});

describe("isolate on any layout", () => {
	// Small deterministic PRNG so failures are reproducible.
	let seed = 1;
	const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const ratios = [1 / 3, 0.5, 2 / 3, 0.25, 0.75];
	const build = (ids: string[]): Layout => {
		if (ids.length === 1) return pane(ids[0]!);
		const k = 1 + Math.floor(rand() * (ids.length - 1));
		return split(build(ids.slice(0, k)), build(ids.slice(k)), rand() < 0.5 ? "row" : "col", ratios[Math.floor(rand() * ratios.length)]!);
	};
	const touches = (p: { x: number; y: number; w: number; h: number }, dir: "row" | "col", pos: number, span: [number, number]) => {
		const [edgeLo, edgeHi, s0, s1] = dir === "row" ? [p.x, p.x + p.w, p.y, p.y + p.h] : [p.y, p.y + p.h, p.x, p.x + p.w];
		const onLine = Math.abs(edgeLo - pos) < 1e-6 || Math.abs(edgeHi - pos) < 1e-6;
		return onLine && s0 < span[1] - 1e-6 && s1 > span[0] + 1e-6;
	};

	test("grabbing a piece changes nothing on screen, and dragging it moves only the panes along that piece", () => {
		for (let iter = 0; iter < 400; iter++) {
			const n = 2 + Math.floor(rand() * 7);
			const l = build(Array.from({ length: n }, (_, i) => `p${i}`));
			for (const d of measure(l).dividers) {
				for (const at of [0.05, 0.3, 0.5, 0.7, 0.95]) {
					const r = isolate(l, d.path, at);
					if (!r) continue;
					const before = Object.fromEntries(measure(l).panes.map((p) => [p.id, p]));
					const turned = Object.fromEntries(measure(r.layout).panes.map((p) => [p.id, p]));
					for (const id of Object.keys(before)) for (const f of ["x", "y", "w", "h"] as const) expect(Math.abs(turned[id]![f] - before[id]![f])).toBeLessThan(0.006);
					const piece = measure(r.layout).dividers.find((x) => x.path.join("") === r.path.join(""))!;
					expect(piece.dir).toBe(d.dir);
					const [s, len] = d.dir === "row" ? [piece.area.y, piece.area.h] : [piece.area.x, piece.area.w];
					expect(s).toBeCloseTo(r.span[0]);
					expect(s + len).toBeCloseTo(r.span[1]);
					const pos = positionOf(piece);
					const moved = Object.fromEntries(measure(moveDividers(r.layout, [r.path], pos + 0.05)).panes.map((p) => [p.id, p]));
					for (const id of Object.keys(turned)) {
						const same = (["x", "y", "w", "h"] as const).every((f) => Math.abs(moved[id]![f] - turned[id]![f]) < 1e-9);
						const t = turned[id]!, A = piece.area;
						const inside = t.x >= A.x - 1e-6 && t.y >= A.y - 1e-6 && t.x + t.w <= A.x + A.w + 1e-6 && t.y + t.h <= A.y + A.h + 1e-6;
						if (!inside) expect(same).toBe(true);
						else if (touches(t, d.dir, pos, r.span)) expect(same).toBe(false);
					}
				}
			}
		}
	});
});

describe("alignPosition", () => {
	const col = (a: Layout, b: Layout, ratio: number): Layout => ({ type: "split", dir: "col", ratio, a, b });
	const row = (a: Layout, b: Layout, ratio = 0.5): Layout => ({ type: "split", dir: "row", ratio, a, b });
	// A|D, B|E, C|F in thirds, with the right side's lower line `off` away from the left one.
	const grid = (off: number) =>
		row(col(pane("A"), col(pane("B"), pane("C"), 0.5), 1 / 3), col(pane("D"), col(pane("E"), pane("F"), (1 / 3 + off) / (2 / 3)), 1 / 3));
	const lower = (l: Layout) => measure(l).dividers.filter((d) => d.dir === "col" && positionOf(d) > 0.5);

	test("lines left slightly apart are not a cross: the lower pieces of the vertical line merge", () => {
		const span = isolate(grid(0.015), [], 0.85)!.span;
		expect(span[0]).toBeCloseTo(1 / 3);
		expect(span[1]).toBeCloseTo(1);
	});

	test("a drop near another divider lands exactly on it", () => {
		const l = grid(0.015);
		const [left, right] = lower(l).sort((a, b) => a.area.x - b.area.x);
		const pos = alignPosition(l, [right!.path], positionOf(right!));
		expect(pos).toBeCloseTo(positionOf(left!));
		const aligned = moveDividers(l, [right!.path], pos);
		const pieces = [0.15, 0.5, 0.85].map((at) => isolate(aligned, [], at)!.span);
		expect(pieces[1]![0]).toBeCloseTo(1 / 3);
		expect(pieces[1]![1]).toBeCloseTo(2 / 3);
		expect(pieces[2]![0]).toBeCloseTo(2 / 3);
	});

	test("far from every divider, or with none the same way, the position stays", () => {
		const l = grid(0.2);
		const [, right] = lower(l).sort((a, b) => a.area.x - b.area.x);
		expect(alignPosition(l, [right!.path], positionOf(right!))).toBeCloseTo(positionOf(right!));
		const one = row(pane("A"), pane("B"));
		expect(alignPosition(one, [[]], 0.3)).toBe(0.3);
	});
});
