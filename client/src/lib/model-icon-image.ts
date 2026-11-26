import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "./protocol";

/** An uploaded model icon is "img:<id>" in a model's `icon`; its bytes live on the server behind the bearer token. */
export const IMG_PREFIX = "img:";
export const isImageIcon = (icon: string | null | undefined): boolean => Boolean(icon?.startsWith(IMG_PREFIX));

export const MAX_ICON_CACHE = 256;

const cache = new Map<string, Promise<string | null>>();
/** The blob: URLs that have already arrived, so a logo can draw them in its first frame instead of waiting a microtask. */
const ready = new Map<string, string>();
/** Monotonic generation per baseUrl (and global) so revoking one server never cancels another server's in-flight fetch. */
let globalGen = 0;
const serverGen = new Map<string, number>();
const keyOf = (conn: { baseUrl: string }, icon: string) => `${conn.baseUrl}\0${icon}`;

function evictOverflow(): void {
	while (ready.size > MAX_ICON_CACHE) {
		const oldest = ready.keys().next().value;
		if (oldest === undefined) break;
		const url = ready.get(oldest)!;
		ready.delete(oldest);
		cache.delete(oldest);
		URL.revokeObjectURL(url);
	}
}

/** The icon's blob: URL when it was loaded before (no flash on a second open), else null. */
export const peekIconImage = (conn: { baseUrl: string }, icon: string): string | null => {
	const key = keyOf(conn, icon);
	const hit = ready.get(key);
	if (hit === undefined) return null;
	// Refresh LRU order on read.
	ready.delete(key);
	ready.set(key, hit);
	return hit;
};

/** A blob: URL for an uploaded icon (an <img> cannot send the token itself). Cached per server and image; null when it cannot be loaded. */
export function loadIconImage(conn: { baseUrl: string; token: string }, icon: string): Promise<string | null> {
	const key = keyOf(conn, icon);
	let hit = cache.get(key);
	if (!hit) {
		const gGen = globalGen;
		const sGen = serverGen.get(conn.baseUrl) ?? 0;
		const raw = fetch(`${conn.baseUrl}/configuration/icons/${encodeURIComponent(icon.slice(IMG_PREFIX.length))}`, {
			headers: { Authorization: `Bearer ${conn.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
		})
			.then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
			.catch(() => null);
		hit = raw.then((u) => {
			if (u === null) {
				if (cache.get(key) === hit) cache.delete(key);
				return null;
			}
			// If this server/cache was invalidated while the fetch was in flight, release the blob URL instead of leaking it.
			if (gGen !== globalGen || (serverGen.get(conn.baseUrl) ?? 0) !== sGen || cache.get(key) !== hit) {
				URL.revokeObjectURL(u);
				return null;
			}
			ready.delete(key);
			ready.set(key, u);
			evictOverflow();
			return u;
		});
		cache.set(key, hit);
	}
	return hit;
}

/** Release cached icon blob URLs belonging to a removed server's baseUrl. */
export function revokeServerIconImages(baseUrl: string): void {
	if (!baseUrl) return;
	const prefix = `${baseUrl}\0`;
	serverGen.set(baseUrl, (serverGen.get(baseUrl) ?? 0) + 1);
	// Safe to drop an old generation entry once bounded: any in-flight fetch for that server captured a non-zero
	// generation or its entry was already removed from `cache`, so it still fails the check on resolution.
	if (serverGen.size > MAX_ICON_CACHE) {
		const oldest = serverGen.keys().next().value;
		if (oldest !== undefined && oldest !== baseUrl) serverGen.delete(oldest);
	}
	for (const [key, url] of ready) {
		if (key.startsWith(prefix)) {
			ready.delete(key);
			URL.revokeObjectURL(url);
		}
	}
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
}

/** Clear all cached icon blob URLs (tests / full reset). */
export function clearIconImageCache(): void {
	globalGen++;
	serverGen.clear();
	for (const url of ready.values()) URL.revokeObjectURL(url);
	ready.clear();
	cache.clear();
}

/** Shrink a picked picture to a 128px square PNG (transparent padding), so uploads stay tiny. Returns base64 without the prefix. */
export async function iconFileToBase64(file: File): Promise<string> {
	if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("PNG, JPEG, WebP");
	const bitmap = await createImageBitmap(file);
	const size = 128;
	const scale = Math.min(size / bitmap.width, size / bitmap.height);
	const w = Math.max(1, Math.round(bitmap.width * scale));
	const h = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	canvas.getContext("2d")!.drawImage(bitmap, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
	bitmap.close();
	const url = canvas.toDataURL("image/png");
	return url.slice(url.indexOf(",") + 1);
}
