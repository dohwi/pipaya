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

/** A count in a narrow column: 1234 -> "1.2k", 25000 -> "25k". Under 1000 as is. */
export function compact(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export interface ChangeSummary {
	/** Every changed file. */
	total: number;
	/** The kinds that have any, in reading order, for the chips under the summary. */
	kinds: { kind: "conflict" | "staged" | "unstaged" | "untracked"; n: number }[];
}

/** The working tree's changes as the panel's one-line summary; null counts (git could not count in time) are no summary. */
export function summarize(counts: { conflict: number; staged: number; unstaged: number; untracked: number } | null): ChangeSummary | null {
	if (!counts) return null;
	const kinds = (["conflict", "staged", "unstaged", "untracked"] as const).flatMap((kind) => (counts[kind] > 0 ? [{ kind, n: counts[kind] }] : []));
	return { total: kinds.reduce((a, k) => a + k.n, 0), kinds };
}
