/**
 * Matching an upstream model id to an OpenRouter catalog entry, the way the server does: the exact id first, else the
 * bare model name (vendor prefix, ":free"-style tags and "-preview" dropped). A bare name that several vendors share
 * is ambiguous and matches nothing.
 */
import type { CatalogModel } from "./types";

export const bareName = (id: string) => id.split("/").pop()!.split(":")[0]!.toLowerCase().replace(/-preview$/, "");

export interface CatalogIndex {
	/** The entry `id` resolves to, or undefined. */
	match(id: string): CatalogModel | undefined;
	/** The entry with exactly this catalog id. */
	byId(id: string): CatalogModel | undefined;
}

export function indexCatalog(catalog: readonly CatalogModel[]): CatalogIndex {
	const ids = new Map(catalog.map((c) => [c.id.toLowerCase(), c]));
	const names = new Map<string, CatalogModel | null>();
	for (const c of catalog) {
		const k = bareName(c.id);
		names.set(k, names.has(k) ? null : c); // same name from several vendors: ambiguous
	}
	return {
		match(id) {
			const v = id.trim().toLowerCase();
			return v ? (ids.get(v) ?? names.get(bareName(v)) ?? undefined) : undefined;
		},
		byId: (id) => ids.get(id.toLowerCase()),
	};
}
