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
