/** Small, pure helpers of the git panel (kept out of the component so they can be tested). */

/** A time in seconds since the epoch as the unit and count the panel words ("3" "h"): the newest end of the scale first. */
export function agoParts(at: number, now: number): { unit: "s" | "m" | "h" | "d" | "mo" | "y"; n: number } {
	const sec = Math.max(0, Math.round(now / 1000 - at));
	if (sec < 60) return { unit: "s", n: sec };
	const min = Math.floor(sec / 60);
	if (min < 60) return { unit: "m", n: min };
	const hour = Math.floor(min / 60);
	if (hour < 24) return { unit: "h", n: hour };
	const day = Math.floor(hour / 24);
	if (day < 30) return { unit: "d", n: day };
	if (day < 365) return { unit: "mo", n: Math.floor(day / 30) };
	return { unit: "y", n: Math.floor(day / 365) };
}

/** `+12 −3` pieces of a file row; nothing for a file without counts (untracked, binary) and nothing for 0/0. */
export function lineCounts(f: { add?: number; del?: number }): { add: number; del: number } | null {
	if (f.add === undefined || f.del === undefined) return null;
	if (f.add === 0 && f.del === 0) return null;
	return { add: f.add, del: f.del };
}

/** A branch's tracking state in one word for its badge: ahead, behind, both, gone (upstream deleted) or none. */
export function trackState(b: { ahead: number; behind: number; gone: boolean; upstream: string | null }): "gone" | "diverged" | "ahead" | "behind" | "synced" | "local" {
	if (b.gone) return "gone";
	if (!b.upstream) return "local";
	if (b.ahead && b.behind) return "diverged";
	if (b.ahead) return "ahead";
	if (b.behind) return "behind";
	return "synced";
}

/** The ref chips of a commit row: HEAD's branch first, then other branches, then tags; `HEAD -> x` is shown as `x`. */
export function refChips(refs: string[]): { label: string; kind: "head" | "branch" | "tag" | "remote" }[] {
	const chips = refs.map((r) => {
		if (r.startsWith("HEAD -> ")) return { label: r.slice(8), kind: "head" as const };
		if (r === "HEAD") return { label: "HEAD", kind: "head" as const };
		if (r.startsWith("tag: ")) return { label: r.slice(5), kind: "tag" as const };
		return { label: r, kind: r.includes("/") ? ("remote" as const) : ("branch" as const) };
	});
	const rank = { head: 0, branch: 1, remote: 2, tag: 3 } as const;
	return chips.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * The five-cell bar of a file row (GitHub's): how its changed lines split between added and removed. Cells are whole, an
 * edit that is all one kind fills the bar with that colour, a tiny edit still shows one cell, and the rest stay empty.
 */
export function diffBar(add: number, del: number, cells = 5): ("add" | "del" | "none")[] {
	const total = add + del;
	if (total <= 0) return Array(cells).fill("none");
	// How many cells are lit grows with the size of the change (log scale: 1 line and 1000 lines must not look alike).
	// Two kinds need two cells at least, so each can show.
	const kinds = (add > 0 ? 1 : 0) + (del > 0 ? 1 : 0);
	const used = Math.min(cells, Math.max(kinds, 1, Math.round((Math.log2(total + 1) / Math.log2(1001)) * cells)));
	let a = Math.round((add / total) * used);
	// each kind that exists keeps at least one cell, and the two never take more than `used`
	if (add > 0) a = Math.max(a, 1);
	if (del > 0) a = Math.min(a, used - 1);
	const bar: ("add" | "del" | "none")[] = [];
	for (let i = 0; i < cells; i++) bar.push(i < a ? "add" : i < used ? "del" : "none");
	return bar;
}

/** A count in a narrow column: 1234 -> "1.2k", 25000 -> "25k". Under 1000 as is. */
export function compact(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The folder part of a path ("src/a" for "src/a/x.ts"), "" for a file at the top. */
export const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether a file matches what was typed: every word of the query must appear in the path, case-insensitively. */
export function matchesFilter(path: string, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const p = path.toLowerCase();
	return words.every((w) => p.includes(w));
}

/**
 * A window onto a long list of equal-height rows: which rows to render for a scroll position. A 2,000-row list renders
 * ~30 nodes instead of 2,000; `before` and `after` are the heights of the rows left out, so the scrollbar stays honest.
 */
export function windowRows(total: number, rowH: number, scrollTop: number, viewH: number, overscan = 6): { from: number; to: number; before: number; after: number } {
	const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
	const last = Math.min(total, Math.ceil((scrollTop + viewH) / rowH) + overscan);
	const from = Math.min(first, total);
	const to = Math.max(from, last);
	return { from, to, before: from * rowH, after: (total - to) * rowH };
}
