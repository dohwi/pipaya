/**
 * Opens connection links (`pipaya://connect?...`) that reach the app: a phone camera that opens the app, a link tapped
 * in a message, or, on desktop, the link passed on the command line. Each link is handled once.
 */
import { isTauri } from "./tauri";
import { parsePairingLink, type PairingLink } from "./pairing";

type Handler = (link: PairingLink) => void;

export async function listenForPairingLinks(handle: Handler): Promise<() => void> {
	if (!isTauri()) return () => {};
	const seen = new Set<string>();
	const take = (urls: string[] | null | undefined) => {
		for (const raw of urls ?? []) {
			if (seen.has(raw)) continue;
			seen.add(raw);
			const link = parsePairingLink(raw);
			if (link) handle(link);
		}
	};
	try {
		const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
		take(await getCurrent()); // the app was started by the link
		return await onOpenUrl(take); // the app was already running
	} catch {
		return () => {};
	}
}
