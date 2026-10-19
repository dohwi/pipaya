/** Recognising picture files for the `read` tool: format by magic bytes (never by extension) and pixel size from the header. */

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageInfo {
	mimeType: ImageMime;
	/** Pixel size when the header could be parsed. */
	width?: number;
	height?: number;
}

/** Providers reject larger pictures (the strictest common limit is 5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** BMP, TIFF, ICO, AVIF/HEIC: pictures, but not in a form the model APIs accept. */
export function isUnsupportedPicture(b: Uint8Array): string | null {
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "BMP";
	if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return "TIFF";
	if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ICO";
	if (b.length >= 12 && ascii(b, 4, 8) === "ftyp" && /^(avif|avis|heic|heix|mif1|msf1)$/.test(ascii(b, 8, 12))) return "AVIF/HEIC";
	return null;
}

/** The format of an image the model APIs accept (PNG, JPEG, GIF, WebP), or null for anything else. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
	if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && ascii(b, 12, 16) === "IHDR") {
		const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
		return { mimeType: "image/png", width: v.getUint32(16), height: v.getUint32(20) };
	}
	if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
		return { mimeType: "image/gif", width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mimeType: "image/jpeg", ...jpegSize(b) };
	if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mimeType: "image/webp", ...webpSize(b) };
	return null;
}

function jpegSize(b: Uint8Array): { width?: number; height?: number } {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) { i++; continue; }
		const marker = b[i + 1]!;
		if (marker === 0xff) { i++; continue; }
		// Markers without a length: padding, TEM, RSTn, SOI, EOI.
		if (marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
		const len = (b[i + 2]! << 8) | b[i + 3]!;
		// SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
		}
		if (len < 2) break;
		i += 2 + len;
	}
	return {};
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
	const kind = ascii(b, 12, 16);
	if (kind === "VP8X" && b.length >= 30) {
		return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
	}
	if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
		const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (kind === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
		return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
	}
	return {};
}

export const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
