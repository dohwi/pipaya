/**
 * Svelte for a server extension's OWN settings page, without a client companion (`pipaya.components` in its package.json).
 *
 * The server carries the component sources; they are compiled by the same compiler and linked to the same kit as a
 * `ui-components` package, so they run in the application realm with the app's full access. That is why nothing runs
 * until the user agreed ON THIS DEVICE, for exactly these sources: the agreement is the SHA-256 of what was shown, so a
 * server that changes the code (an update, or a compromised server) asks again. Safe mode runs none of it.
 *
 * The reach is limited to the extension's own page: the slot `extension.page.top`, the part `extension.settings` and the
 * `component` of its settings fields. Everything else a package could mount is refused here, whatever the server says.
 *
 * Pure helpers; the reactive state is `own-ui.svelte.ts`.
 */
import { canonical, sha256 } from "./fingerprint";
import { parsePackage, type ExtensionPackage } from "./schema";

/** What `GET /server-extensions/:name/ui` returns. Untrusted. */
export interface OwnUiSources {
	components: Record<string, string>;
	mounts: { slot: string; component: string; order?: number }[];
	replaces: Record<string, string>;
}

export const OWN_PAGE_SLOT = "extension.page.top";
export const OWN_PAGE_PART = "extension.settings";

/** The agreement is bound to this value: the sources, the mounts and the part, in a stable order. */
export const ownUiFingerprint = (sources: OwnUiSources): string => sha256(canonical({ components: sources.components, mounts: sources.mounts, replaces: sources.replaces }));

/**
 * The sources as a validated package (the same parser, limits and component names as `ui-components`), or a throw with
 * why not. Only the extension's own page may be reached: any other slot or part is refused.
 */
export function ownUiPackage(id: string, name: string, sources: OwnUiSources): ExtensionPackage {
	const mounts = Array.isArray(sources.mounts) ? sources.mounts : [];
	for (const m of mounts) if (m?.slot !== OWN_PAGE_SLOT) throw new Error(`mounts: only ${OWN_PAGE_SLOT} is available to a server extension's page`);
	const replaces = sources.replaces && typeof sources.replaces === "object" ? sources.replaces : {};
	for (const part of Object.keys(replaces)) if (part !== OWN_PAGE_PART) throw new Error(`replaces: only ${OWN_PAGE_PART} is available to a server extension's page`);
	return parsePackage({
		manifest: { id, name, version: "0.0.0", sdkVersion: 1, permissions: ["ui-components"] },
		components: sources.components,
		...(mounts.length ? { mounts } : {}),
		...(Object.keys(replaces).length ? { replaces } : {}),
	});
}

/** Where the agreements live on this device: { "<serverId>:<extension name>": fingerprint }. */
export const OWN_UI_CONSENT_KEY = "pipaya.extensions.own-ui";
export const ownUiKey = (serverId: string, name: string): string => `${serverId}:${name}`;

export interface ConsentStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readOwnUiConsent(storage: ConsentStorage): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		const raw: unknown = JSON.parse(storage.getItem(OWN_UI_CONSENT_KEY) ?? "{}");
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const [key, value] of Object.entries(raw)) if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && key.length <= 200) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
		}
	} catch { /* unreadable: nothing was agreed to */ }
	return out;
}

export function writeOwnUiConsent(storage: ConsentStorage, consent: Record<string, string>): void {
	try { storage.setItem(OWN_UI_CONSENT_KEY, JSON.stringify(consent)); } catch { /* the choice lasts until the page is closed */ }
}
