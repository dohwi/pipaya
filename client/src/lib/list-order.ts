/**
 * Stable partition-sort for settings and management lists: active items stay on top and
 * disabled / inactive items sink to the bottom, preserving original relative order within
 * each tier.
 *
 * Accepts either a boolean predicate (`true` = top, `false` = bottom) or a numeric rank
 * (lower rank = higher in the list, e.g. `0` active, `1` shadowed/unavailable, `2` disabled).
 */
export function sortActiveFirst<T>(items: readonly T[], active: (item: T) => boolean): T[];
export function sortActiveFirst<T>(items: readonly T[], rank: (item: T) => number): T[];
export function sortActiveFirst<T>(items: readonly T[], score: (item: T) => boolean | number): T[] {
	if (items.length <= 1) return [...items];
	return items
		.map((item, index) => {
			const v = score(item);
			const rank = typeof v === "boolean" ? (v ? 0 : 1) : Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
			return { item, rank, index };
		})
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.item);
}
