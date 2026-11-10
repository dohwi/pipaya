import { expect, test } from "bun:test";
import { layoutGraph } from "../src/lib/git-graph";
import type { GitCommit } from "../src/lib/types";

const c = (hash: string, ...parents: string[]): GitCommit => ({ hash, parents, subject: hash, author: "a", at: 0, refs: [] });

test("a straight history stays on one lane", () => {
	const g = layoutGraph([c("c", "b"), c("b", "a"), c("a")], 5);
	expect(g.lanes).toBe(1);
	expect(g.rows.map((r) => r.col)).toEqual([0, 0, 0]);
});

test("a merge opens a second lane and the fork closes it", () => {
	// m merges x (side) into b; both descend from a
	const g = layoutGraph([c("m", "b", "x"), c("x", "a"), c("b", "a"), c("a")], 5);
	expect(g.lanes).toBe(2);
	expect(g.rows[0]!.segs.some((s) => s.x1 === 0 && s.x2 === 1)).toBe(true);
	expect(g.rows[1]!.col).toBe(1);
	// b joins the lane a already waits in (as `git log --graph` does), so a sits on lane 1
	expect(g.rows[2]!.segs.some((s) => s.x1 === 0 && s.x2 === 1 && s.y2 === 1)).toBe(true);
	expect(g.rows[3]!.col).toBe(1);
});
