/**
 * Fetch the UI language packs a server publishes. Only packs that changed since the copy held are downloaded; a failed
 * download keeps the copy already held (or none). Plain TS with the server calls passed in, so it is testable.
 */
import { remotePack, remotePackVersions, type LanguagePack } from "./i18n";

export interface LocaleSource {
	locales(): Promise<{ tag: string; updatedAt: number }[]>;
	locale(tag: string): Promise<unknown>;
}

/** The packs to hand to `setRemotePacks`. Throws when the list itself cannot be read (offline: keep the cache). */
export async function fetchLocalePacks(api: LocaleSource, held: {
	versions: () => Record<string, number>;
	pack: (tag: string) => LanguagePack | undefined;
} = { versions: remotePackVersions, pack: remotePack }): Promise<unknown[]> {
	const list = await api.locales();
	const have = held.versions();
	const packs = await Promise.all(
		list.map(async (info) => {
			const cached = held.pack(info.tag);
			if (cached && have[info.tag] === info.updatedAt) return cached;
			try {
				return await api.locale(info.tag);
			} catch {
				return cached; // keep what we have
			}
		}),
	);
	return packs.filter((p) => p !== undefined);
}
