import { expect, test } from "bun:test";
import { agoParts, lineCounts, refChips, trackState } from "../src/lib/git-view";

test("agoParts walks up the scale", () => {
	const now = 1_000_000_000_000;
	const at = (secAgo: number) => now / 1000 - secAgo;
	expect(agoParts(at(5), now)).toEqual({ unit: "s", n: 5 });
	expect(agoParts(at(120), now)).toEqual({ unit: "m", n: 2 });
	expect(agoParts(at(3 * 3600), now)).toEqual({ unit: "h", n: 3 });
	expect(agoParts(at(2 * 86400), now)).toEqual({ unit: "d", n: 2 });
	expect(agoParts(at(65 * 86400), now)).toEqual({ unit: "mo", n: 2 });
	expect(agoParts(at(800 * 86400), now)).toEqual({ unit: "y", n: 2 });
	// a clock a little behind the server never reads as negative
	expect(agoParts(at(-30), now)).toEqual({ unit: "s", n: 0 });
});

test("lineCounts hides what is not worth a number", () => {
	expect(lineCounts({ add: 3, del: 1 })).toEqual({ add: 3, del: 1 });
	expect(lineCounts({ add: 0, del: 0 })).toBeNull();
	expect(lineCounts({})).toBeNull();
	expect(lineCounts({ add: 2 })).toBeNull();
});

test("trackState names each case once", () => {
	const b = { ahead: 0, behind: 0, gone: false, upstream: "origin/x" as string | null };
	expect(trackState(b)).toBe("synced");
	expect(trackState({ ...b, ahead: 1 })).toBe("ahead");
	expect(trackState({ ...b, behind: 1 })).toBe("behind");
	expect(trackState({ ...b, ahead: 1, behind: 1 })).toBe("diverged");
	expect(trackState({ ...b, gone: true })).toBe("gone");
	expect(trackState({ ...b, upstream: null })).toBe("local");
});

test("refChips puts HEAD's branch first and unwraps tags", () => {
	expect(refChips(["tag: v1", "origin/main", "feature", "HEAD -> main"])).toEqual([
		{ label: "main", kind: "head" },
		{ label: "feature", kind: "branch" },
		{ label: "origin/main", kind: "remote" },
		{ label: "v1", kind: "tag" },
	]);
	expect(refChips(["HEAD"])).toEqual([{ label: "HEAD", kind: "head" }]);
});

import { baseOf, compact, dirOf, diffBar, matchesFilter, windowRows } from "../src/lib/git-view";

test("diffBar: five whole cells, never empty for a change, never overflowing", () => {
	expect(diffBar(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
	const one = diffBar(1, 0);
	expect(one.filter((c) => c !== "none").length).toBeGreaterThanOrEqual(1);
	expect(one[0]).toBe("add");
	const delOnly = diffBar(0, 50);
	expect(delOnly.includes("add")).toBe(false);
	expect(delOnly[0]).toBe("del");
	for (const [a, d] of [[1, 1], [3, 1], [1, 3], [500, 500], [100000, 1], [1, 100000], [7, 0], [0, 7]] as const) {
		const bar = diffBar(a, d);
		expect(bar.length).toBe(5);
		// order is adds, then dels, then empty, with no gaps
		expect(bar.join(",") + ",").toMatch(/^(add,)*(del,)*(none,)*$/);
		if (a > 0) expect(bar.includes("add")).toBe(true);
		if (d > 0) expect(bar.includes("del")).toBe(true);
	}
	// a one-line edit and a huge rewrite do not look alike
	expect(diffBar(1, 0).filter((c) => c !== "none").length).toBeLessThan(diffBar(900, 900).filter((c) => c !== "none").length);
});

test("compact shortens big numbers for a narrow column", () => {
	expect([0, 999, 1000, 1234, 9999, 10_000, 25_400, 999_999, 1_200_000].map(compact)).toEqual(["0", "999", "1k", "1.2k", "10k", "10k", "25k", "1000k", "1.2M"]);
});

test("dirOf and baseOf split a path at the last slash", () => {
	expect([dirOf("src/a/x.ts"), baseOf("src/a/x.ts")]).toEqual(["src/a", "x.ts"]);
	expect([dirOf("x.ts"), baseOf("x.ts")]).toEqual(["", "x.ts"]);
});

test("matchesFilter needs every word, in any order", () => {
	expect(matchesFilter("src/a/Login.svelte", "")).toBe(true);
	expect(matchesFilter("src/a/Login.svelte", "login src")).toBe(true);
	expect(matchesFilter("src/a/Login.svelte", "login docs")).toBe(false);
	expect(matchesFilter("src/a/Login.svelte", "  LOGIN ")).toBe(true);
});

test("windowRows renders only what is on screen and keeps the scroll height", () => {
	const w = windowRows(2000, 32, 0, 320, 6);
	expect(w.from).toBe(0);
	expect(w.to).toBe(16);
	expect(w.before).toBe(0);
	expect(w.before + (w.to - w.from) * 32 + w.after).toBe(2000 * 32);
	const mid = windowRows(2000, 32, 32 * 1000, 320, 6);
	expect(mid.to - mid.from).toBeLessThan(30);
	expect(mid.before + (mid.to - mid.from) * 32 + mid.after).toBe(2000 * 32);
	const end = windowRows(2000, 32, 1e9, 320, 6);
	expect(end.to).toBe(2000);
	expect(end.after).toBe(0);
	expect(windowRows(0, 32, 0, 320)).toEqual({ from: 0, to: 0, before: 0, after: 0 });
	const few = windowRows(3, 32, 0, 320);
	expect(few.to).toBe(3);
});
