/**
 * Keyed `{#each}` blocks that cannot take the app down. Svelte throws `each_key_duplicate` when a key repeats, and a throw
 * while rendering drops the whole window to the crash screen (Root.svelte). Lists come from servers, other devices,
 * extensions and agents, and a production build does not say which list broke, so chasing every source (#180) was not
 * enough. The build points every compiled component's `svelte/internal/client` import here (scripts/each-guard-plugin.ts):
 * this module is that runtime plus `each_in`, which the plugin writes in place of `$.each`: a repeated key keeps its first
 * item and is reported once on the console, naming the component's file, the block and the key.
 */
// @ts-expect-error the runtime has no public typings; compiled components link to it
import { each as svelteEach, index } from "svelte/internal/client";

// @ts-expect-error the same runtime, re-exported whole: only `each` below differs
export * from "svelte/internal/client";

type KeyOf = (item: unknown, i: number) => unknown;

/** `list` without the items whose key came earlier (first one wins, order kept); `list` itself when nothing repeats. */
export function keepFirstKeys<T>(list: readonly T[], key: KeyOf, repeated?: (key: unknown) => void): T[] {
	const seen = new Set<unknown>();
	let out: T[] | null = null;
	for (let i = 0; i < list.length; i++) {
		const item = list[i] as T;
		const k = key(item, i);
		if (!seen.has(k)) {
			seen.add(k);
			out?.push(item);
			continue;
		}
		out ??= list.slice(0, i);
		repeated?.(k);
	}
	return out ?? (list as T[]);
}

/** Repeats already reported (component + key), so a list redrawn every frame does not flood the console; capped. */
const told = new Set<string>();

function report(where: string, key: unknown): void {
	const k = typeof key === "string" || typeof key === "number" ? String(key) : typeof key;
	const line = `${where || "?"}: ${k.slice(0, 120)}`;
	if (told.has(line) || told.size >= 100) return;
	told.add(line);
	console.error(`each_key_duplicate in ${line} (showing the first item only)`);
}

const toArray = (c: unknown): unknown[] => (Array.isArray(c) ? c : c == null ? [] : Array.from(c as Iterable<unknown>));

/** `$.each` with the component's file named: what the build plugin writes for every keyed or unkeyed each block. */
export function each_in(where: string, node: unknown, flags: number, collection: () => unknown, key: KeyOf, render: unknown, fallback: unknown = null): unknown {
	if (key === index) return svelteEach(node, flags, collection, key, render, fallback); // by position: cannot repeat
	return svelteEach(node, flags, () => keepFirstKeys(toArray(collection()), key, (k) => report(where, k)), key, render, fallback);
}
