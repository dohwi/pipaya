import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "./protocol";

/** An uploaded model icon is "img:<id>" in a model's `icon`; its bytes live on the server behind the bearer token. */
export const IMG_PREFIX = "img:";
export const isImageIcon = (icon: string | null | undefined): boolean => Boolean(icon?.startsWith(IMG_PREFIX));

const cache = new Map<string, Promise<string | null>>();

/** A blob: URL for an uploaded icon (an <img> cannot send the token itself). Cached per server and image; null when it cannot be loaded. */
export function loadIconImage(conn: { baseUrl: string; token: string }, icon: string): Promise<string | null> {
	const key = `${conn.baseUrl}\0${icon}`;
	let hit = cache.get(key);
	if (!hit) {
		hit = fetch(`${conn.baseUrl}/configuration/icons/${encodeURIComponent(icon.slice(IMG_PREFIX.length))}`, {
			headers: { Authorization: `Bearer ${conn.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
		})
			.then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
			.catch(() => null);
		cache.set(key, hit);
		void hit.then((u) => { if (u === null) cache.delete(key); }); // retry later after a failure
	}
	return hit;
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
