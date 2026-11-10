import { expect, test } from "bun:test";
import { agoParts, chipsFor, compact, lineShare, refChips, summarize, trackState } from "../src/lib/git-view";

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

test("compact shortens big numbers for a narrow column", () => {
	expect([0, 999, 1000, 1234, 9999, 10_000, 25_400, 999_999, 1_200_000].map(compact)).toEqual(["0", "999", "1k", "1.2k", "10k", "10k", "25k", "1000k", "1.2M"]);
});

test("summarize totals the kinds and drops the empty ones", () => {
	expect(summarize({ conflict: 0, staged: 2, unstaged: 0, untracked: 5 })).toEqual({
		total: 7,
		kinds: [{ kind: "staged", n: 2 }, { kind: "untracked", n: 5 }],
	});
	expect(summarize({ conflict: 1, staged: 1, unstaged: 1, untracked: 1 })!.kinds.map((k) => k.kind)).toEqual(["conflict", "staged", "unstaged", "untracked"]);
	expect(summarize({ conflict: 0, staged: 0, unstaged: 0, untracked: 0 })).toEqual({ total: 0, kinds: [] });
	// git could not count in time: no summary, not "0 files"
	expect(summarize(null)).toBeNull();
});

test("lineShare splits into whole percents that add to 100", () => {
	expect(lineShare(0, 0)).toBeNull();
	expect(lineShare(1, 1)).toEqual({ add: 50, del: 50 });
	expect(lineShare(3, 1)).toEqual({ add: 75, del: 25 });
	expect(lineShare(10, 0)).toEqual({ add: 100, del: 0 });
	expect(lineShare(0, 10)).toEqual({ add: 0, del: 100 });
	for (const [a, d] of [[1, 99999], [99999, 1], [333, 667], [7, 13]] as const) {
		const s = lineShare(a, d)!;
		expect(s.add + s.del).toBe(100);
	}
});

test("a share that exists never vanishes in the bar", () => {
	// 3 added against 100,000 removed would be 0%: it keeps a visible sliver
	expect(lineShare(3, 100_000)!.add).toBeGreaterThanOrEqual(4);
	expect(lineShare(100_000, 3)!.del).toBeGreaterThanOrEqual(4);
});

test("chipsFor keeps one chip and counts the rest", () => {
	expect(chipsFor([])).toEqual({ shown: null, more: 0, all: "" });
	expect(chipsFor(["HEAD -> main"])).toEqual({ shown: { label: "main", kind: "head" }, more: 0, all: "main" });
	const c = chipsFor(["tag: v1", "origin/main", "feature", "HEAD -> main"]);
	expect(c.shown).toEqual({ label: "main", kind: "head" });
	expect(c.more).toBe(3);
	expect(c.all).toBe("main, feature, origin/main, v1");
});
