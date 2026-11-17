/**
 * Lists drawn with a keyed `{#each}` must not repeat a key: Svelte throws `each_key_duplicate` and the whole app falls to
 * the crash screen. Data from a server, another device or an agent can repeat (the same option offered twice, a list
 * that was synced twice), so the lists that take such data pass through here first. Pure, so tests can import it.
 */

/** `list` without the items whose key came earlier; the first one wins and the order stays. Returns `list` itself when nothing repeats. */
export function uniqueBy<T>(list: readonly T[], key: (item: T) => unknown): T[] {
	const seen = new Set<unknown>();
	const out: T[] = [];
	for (const item of list) {
		const k = key(item);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(item);
	}
	return out.length === list.length ? (list as T[]) : out;
}

/** Plain values without repeats (strings, numbers), first one wins. */
export const unique = <T>(list: readonly T[]): T[] => uniqueBy(list, (x) => x);
