/**
 * Shrinks a picture until it fits a model's limits (pixels and encoded size). Runs the Photon (Rust/WASM) codec, so it
 * is meant to be called from a worker (see image-resize.ts); the decode/resize/encode steps take seconds for big photos.
 */

export interface ResizeLimits {
	maxWidth: number;
	maxHeight: number;
	/** Largest base64 payload, in bytes. */
	maxBytes: number;
	jpegQuality: number;
}

/** 4.5 MB of base64: headroom below the 5 MB most providers enforce. */
export const DEFAULT_LIMITS: ResizeLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80 };

export interface ResizedImage {
	/** base64 */
	data: string;
	mimeType: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
}

const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

// Photon's declarations are loose and the module is loaded lazily, so it is typed by hand where it is used.
type Photon = typeof import("@silvia-odwyer/photon-node");
type PhotonImage = import("@silvia-odwyer/photon-node").PhotonImage;

let photonPromise: Promise<Photon | null> | null = null;
const loadPhoton = (): Promise<Photon | null> => (photonPromise ??= import("@silvia-odwyer/photon-node").then((m) => m, () => null));

/** EXIF "Orientation" (1..8) of a JPEG or WebP; 1 when absent or unreadable. */
export function exifOrientation(b: Uint8Array): number {
	const tiff = b[0] === 0xff && b[1] === 0xd8 ? jpegTiffOffset(b) : b.length >= 12 && b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45 ? webpTiffOffset(b) : -1;
	if (tiff < 0 || tiff + 8 > b.length) return 1;
	const le = b[tiff] === 0x49;
	const r16 = (p: number) => (le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!);
	const r32 = (p: number) => (le ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0 : ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0);
	const ifd = tiff + r32(tiff + 4);
	if (ifd + 2 > b.length) return 1;
	const n = r16(ifd);
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		if (e + 12 > b.length) return 1;
		if (r16(e) === 0x0112) {
			const v = r16(e + 8);
			return v >= 1 && v <= 8 ? v : 1;
		}
	}
	return 1;
}

const isExifHeader = (b: Uint8Array, o: number) => b[o] === 0x45 && b[o + 1] === 0x78 && b[o + 2] === 0x69 && b[o + 3] === 0x66 && b[o + 4] === 0 && b[o + 5] === 0;

function jpegTiffOffset(b: Uint8Array): number {
	let o = 2;
	while (o + 4 <= b.length) {
		if (b[o] !== 0xff) return -1;
		const marker = b[o + 1]!;
		if (marker === 0xff) { o++; continue; }
		// SOS: entropy-coded data follows, no more metadata.
		if (marker === 0xda) return -1;
		if (marker === 0xe1 && o + 10 <= b.length && isExifHeader(b, o + 4)) return o + 10;
		o += 2 + ((b[o + 2]! << 8) | b[o + 3]!);
	}
	return -1;
}

function webpTiffOffset(b: Uint8Array): number {
	let o = 12;
	while (o + 8 <= b.length) {
		const id = String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
		const size = (b[o + 4]! | (b[o + 5]! << 8) | (b[o + 6]! << 16) | (b[o + 7]! << 24)) >>> 0;
		const start = o + 8;
		if (id === "EXIF") return size >= 6 && isExifHeader(b, start) ? start + 6 : start;
		o = start + size + (size % 2);
	}
	return -1;
}

function rotate90(photon: Photon, img: PhotonImage, dst: (x: number, y: number, w: number, h: number) => number): PhotonImage {
	const w = img.get_width();
	const h = img.get_height();
	const src = img.get_raw_pixels();
	const out = new Uint8Array(src.length);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const s = (y * w + x) * 4;
			const d = dst(x, y, w, h) * 4;
			out[d] = src[s]!; out[d + 1] = src[s + 1]!; out[d + 2] = src[s + 2]!; out[d + 3] = src[s + 3]!;
		}
	}
	return new photon.PhotonImage(out, h, w);
}

/** Turns the pixels upright according to the EXIF orientation. Rotations return a new image; flips work in place. */
function uprightImage(photon: Photon, img: PhotonImage, bytes: Uint8Array): PhotonImage {
	const cw = (x: number, y: number, _w: number, h: number) => x * h + (h - 1 - y);
	const ccw = (x: number, y: number, w: number, h: number) => (w - 1 - x) * h + y;
	switch (exifOrientation(bytes)) {
		case 2: photon.fliph(img); return img;
		case 3: photon.fliph(img); photon.flipv(img); return img;
		case 4: photon.flipv(img); return img;
		case 5: { const r = rotate90(photon, img, cw); photon.fliph(r); return r; }
		case 6: return rotate90(photon, img, cw);
		case 7: { const r = rotate90(photon, img, ccw); photon.fliph(r); return r; }
		case 8: return rotate90(photon, img, ccw);
		default: return img;
	}
}

/**
 * Fits a picture into the limits: first the pixel size, then, while the encoding is still too big, JPEG at lower
 * quality and finally smaller dimensions. PNG and JPEG are both tried and the smaller one that fits wins.
 * Returns null when the bytes are not a picture Photon can decode or nothing fits.
 */
export async function resizeToFit(input: Uint8Array, limits: Partial<ResizeLimits> = {}): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_LIMITS, ...limits };
	const photon = await loadPhoton();
	if (!photon) return null;
	let raw: PhotonImage | undefined;
	let img: PhotonImage | undefined;
	try {
		raw = photon.PhotonImage.new_from_byteslice(input);
		img = uprightImage(photon, raw, input);
		if (img !== raw) { raw.free(); raw = undefined; }
		const originalWidth = img.get_width();
		const originalHeight = img.get_height();
		let w = originalWidth;
		let h = originalHeight;
		if (w > opts.maxWidth) { h = Math.max(1, Math.round((h * opts.maxWidth) / w)); w = opts.maxWidth; }
		if (h > opts.maxHeight) { w = Math.max(1, Math.round((w * opts.maxHeight) / h)); h = opts.maxHeight; }
		const qualities = [...new Set([opts.jpegQuality, 85, 70, 55, 40])];
		for (;;) {
			const resized: PhotonImage = w === originalWidth && h === originalHeight ? img : photon.resize(img, w, h, photon.SamplingFilter.Lanczos3);
			try {
				const candidates: { bytes: Uint8Array; mimeType: string }[] = [{ bytes: resized.get_bytes(), mimeType: "image/png" }];
				for (const q of qualities) candidates.push({ bytes: resized.get_bytes_jpeg(q), mimeType: "image/jpeg" });
				const fit = candidates.filter((c) => base64Size(c.bytes.byteLength) < opts.maxBytes).sort((a, b) => a.bytes.byteLength - b.bytes.byteLength)[0];
				if (fit) return { data: Buffer.from(fit.bytes).toString("base64"), mimeType: fit.mimeType, width: w, height: h, originalWidth, originalHeight };
			} finally {
				if (resized !== img) resized.free();
			}
			if (w === 1 && h === 1) return null;
			w = Math.max(1, Math.floor(w * 0.75));
			h = Math.max(1, Math.floor(h * 0.75));
		}
	} catch {
		return null;
	} finally {
		if (img && img !== raw) img.free();
		raw?.free();
	}
}
