import { describe, expect, test } from "bun:test";
import { detach, linkedDividers, moveDividers, snapPosition, measure, MAX_RATIO, MIN_RATIO, pair, pane, panesOf, place, remove, replaceSession, setRatio, splitAt, swap, worthKeeping, zoneAt, type Layout } from "../src/lib/layout";

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

describe("detach", () => {
	// left column (a over b) | right column (c over d): the vertical line is one node
	const grid = split(split(pane("a"), pane("b"), "col", 0.3), split(pane("c"), pane("d"), "col", 0.7), "row", 0.5);

	test("turns the grid so each half of the vertical line has its own node", () => {
		const r = detach(grid, [], 0)!;
		expect(r.path).toEqual(["a"]);
		const top = setRatio(r.layout, r.path, 0.8);
		const by = Object.fromEntries(measure(top).panes.map((p) => [p.id, p]));
		expect(by.a!.w).toBeCloseTo(0.8); // top row moved
		expect(by.b!.w).toBeCloseTo(0.5); // bottom row did not
		expect(by.d!.x).toBeCloseTo(0.5);
	});
	test("the lower half is the second node", () => {
		expect(detach(grid, [], 1)!.path).toEqual(["b"]);
	});
	test("keeps every pane and the position of the vertical line", () => {
		const r = detach(grid, [], 0)!;
		expect(panesOf(r.layout).sort()).toEqual(["a", "b", "c", "d"]);
		const by = Object.fromEntries(measure(r.layout).panes.map((p) => [p.id, p]));
		expect(by.a!.w).toBeCloseTo(0.5);
		expect(by.a!.h).toBeCloseTo(0.5);
	});
	test("nothing to separate for a plain split", () => {
		expect(detach(pair("a", "b"), [], 0)).toBeNull();
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
