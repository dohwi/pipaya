export interface Attachment {
	id: string;
	name: string;
	/** data: URL for preview */
	preview: string;
	data: string; // base64 without prefix
	mimeType: string;
}

import { uid } from "./format";

const MAX_EDGE = 1568;

/** Downscale large images so we do not push multi-megabyte base64 over a mobile link. */
export async function fileToAttachment(file: File): Promise<Attachment> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
	const w = Math.round(bitmap.width * scale);
	const h = Math.round(bitmap.height * scale);
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(bitmap, 0, 0, w, h);
	bitmap.close();
	// Keep PNG for small images (screenshots stay crisp); JPEG for big photos.
	const keepPng = file.type === "image/png" && file.size < 600_000;
	const mimeType = keepPng ? "image/png" : "image/jpeg";
	const preview = canvas.toDataURL(mimeType, 0.85);
	return {
		id: uid(),
		name: file.name || "image",
		preview,
		data: preview.slice(preview.indexOf(",") + 1),
		mimeType,
	};
}
