import { describe, expect, test } from "bun:test";
import { treeMove } from "../src/lib/tree-keys";

const head = (open: boolean, more: Partial<{ parent: number; firstChild: number; foldable: boolean }> = {}) => ({ header: true, open, foldable: true, parent: -1, firstChild: -1, ...more });
const row = (parent: number) => ({ header: false, open: false, foldable: false, parent, firstChild: -1 });

describe("treeMove", () => {
	test("up and down walk the rows, stopping at the ends", () => {
		expect(treeMove("ArrowDown", 0, 3, row(-1))).toEqual({ kind: "focus", to: 1 });
		expect(treeMove("ArrowDown", 2, 3, row(-1))).toBeNull();
		expect(treeMove("ArrowUp", 0, 3, row(-1))).toBeNull();
		expect(treeMove("ArrowUp", 2, 3, row(-1))).toEqual({ kind: "focus", to: 1 });
		expect(treeMove("Home", 2, 3, row(-1))).toEqual({ kind: "focus", to: 0 });
		expect(treeMove("End", 0, 3, row(-1))).toEqual({ kind: "focus", to: 2 });
	});
	test("right unfolds a folded header, then steps into its first row", () => {
		expect(treeMove("ArrowRight", 1, 5, head(false))).toEqual({ kind: "toggle" });
		expect(treeMove("ArrowRight", 1, 5, head(true, { firstChild: 2 }))).toEqual({ kind: "focus", to: 2 });
		expect(treeMove("ArrowRight", 1, 5, head(true))).toBeNull();
	});
	test("left folds an open header, else goes up to the header around it", () => {
		expect(treeMove("ArrowLeft", 1, 5, head(true, { parent: 0 }))).toEqual({ kind: "toggle" });
		expect(treeMove("ArrowLeft", 1, 5, head(false, { parent: 0 }))).toEqual({ kind: "focus", to: 0 });
		expect(treeMove("ArrowLeft", 3, 5, row(1))).toEqual({ kind: "focus", to: 1 });
		expect(treeMove("ArrowLeft", 0, 5, head(false))).toBeNull();
	});
	test("a header that cannot fold (an unreachable server) does not toggle", () => {
		expect(treeMove("ArrowRight", 0, 2, head(false, { foldable: false }))).toBeNull();
		expect(treeMove("ArrowLeft", 1, 2, head(true, { foldable: false, parent: 0 }))).toEqual({ kind: "focus", to: 0 });
	});
	test("other keys are left alone", () => {
		expect(treeMove("Enter", 0, 2, head(false))).toBeNull();
		expect(treeMove("ArrowDown", -1, 2, row(-1))).toBeNull();
	});
});
