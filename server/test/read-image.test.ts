import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as photon from "@silvia-odwyer/photon-node";
import { isUnsupportedPicture, sniffImage } from "../src/image-file.ts";
import { exifOrientation, resizeToFit } from "../src/image-resize-core.ts";
import { buildTools } from "../src/tools.ts";

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAgADAIAAAAAAAP///yH5BAEAAAAALAAAAAACAAMAAAIDhI9YADs=", "base64");
const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
const webpLossless = (w: number, h: number) => {
	const bits = (w - 1) | ((h - 1) << 14);
	const b = Buffer.alloc(30);
	b.write("RIFF", 0); b.write("WEBP", 8); b.write("VP8L", 12); b[20] = 0x2f; b.writeUInt32LE(bits >>> 0, 21);
	return b;
};

/** Random-looking pixels: they do not compress, so the encoded file is big. */
function noisePx(w: number, h: number): Uint8Array {
	const px = new Uint8Array(w * h * 4);
	let x = 12345;
	for (let i = 0; i < px.length; i += 4) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		px[i] = x >>> 8; px[i + 1] = x >>> 16; px[i + 2] = x >>> 24; px[i + 3] = 255;
	}
	return px;
}
const noisePng = (w: number, h: number) => Buffer.from(new photon.PhotonImage(noisePx(w, h), w, h).get_bytes());
const photonJpeg = (w: number, h: number) => Buffer.from(new photon.PhotonImage(noisePx(w, h), w, h).get_bytes_jpeg(90));
/** Inserts an APP1/Exif segment with only the Orientation tag right after SOI. */
function withOrientation(jpegBytes: Buffer, orientation: number): Buffer {
	const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
	const body = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
	const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
	return Buffer.concat([jpegBytes.subarray(0, 2), seg, jpegBytes.subarray(2)]);
}

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-readimg-"));
	writeFileSync(join(dir, "a.png"), PNG);
	writeFileSync(join(dir, "renamed.txt"), PNG);
	writeFileSync(join(dir, "fake.png"), "just text\nsecond line\n");
	writeFileSync(join(dir, "pic.gif"), GIF);
	writeFileSync(join(dir, "wide.jpg"), jpeg(9000, 100));
	writeFileSync(join(dir, "big.png"), noisePng(3000, 1500));
	writeFileSync(join(dir, "corrupt.png"), Buffer.concat([PNG.subarray(0, 24), Buffer.alloc(5 * 1024 * 1024 + 1)]));
	writeFileSync(join(dir, "turned.jpg"), withOrientation(photonJpeg(40, 20), 6));
	writeFileSync(join(dir, "x.bmp"), Buffer.concat([Buffer.from("BM"), Buffer.alloc(60)]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (path: string, canSee?: boolean) => {
	const tool = buildTools(["read"], dir, [], canSee === undefined ? {} : { canSeeImages: () => canSee })[0]!;
	return tool.execute("t", { path }, undefined as never) as Promise<{ content: any[]; details: any }>;
};

describe("sniffImage", () => {
	test("reads format and size from the header", () => {
		expect(sniffImage(PNG)).toEqual({ mimeType: "image/png", width: 1, height: 1 });
		expect(sniffImage(GIF)).toEqual({ mimeType: "image/gif", width: 2, height: 3 });
		expect(sniffImage(jpeg(640, 480))).toEqual({ mimeType: "image/jpeg", width: 640, height: 480 });
		expect(sniffImage(webpLossless(300, 200))).toEqual({ mimeType: "image/webp", width: 300, height: 200 });
	});
	test("returns null for text and truncated data", () => {
		expect(sniffImage(Buffer.from("hello world, plain text"))).toBeNull();
		expect(sniffImage(PNG.subarray(0, 10))).toBeNull();
		expect(sniffImage(Buffer.alloc(0))).toBeNull();
	});
	test("names formats the models cannot take", () => {
		expect(isUnsupportedPicture(Buffer.from("BM\0\0"))).toBe("BMP");
		expect(isUnsupportedPicture(Buffer.from("plain"))).toBeNull();
	});
});

describe("read tool with images", () => {
	test("returns an image block plus a note", async () => {
		const r = await read("a.png");
		expect(r.content[0]).toMatchObject({ type: "text" });
		expect(r.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
		expect(r.details).toMatchObject({ path: "a.png", image: true, shown: true, width: 1, height: 1 });
	});
	test("detects by content, not by extension", async () => {
		expect((await read("renamed.txt")).content[1]?.type).toBe("image");
		const t = await read("fake.png");
		expect(t.content).toHaveLength(1);
		expect(t.content[0].text).toContain("just text");
	});
	test("supports gif", async () => {
		expect((await read("pic.gif")).content[1]?.mimeType).toBe("image/gif");
	});
	test("leaves the picture out when the model cannot see images", async () => {
		const r = await read("a.png", false);
		expect(r.content).toHaveLength(1);
		expect(r.content[0].text).toContain("cannot see images");
		expect(r.details.shown).toBe(false);
		expect((await read("a.png", true)).content).toHaveLength(2);
	});
	test("shrinks a picture that is too big for the model instead of refusing it", async () => {
		const r = await read("big.png");
		expect(r.content).toHaveLength(2);
		expect(r.content[0].text).toContain("resized to 2000x1000");
		expect(r.details).toMatchObject({ shown: true, resized: true, width: 2000, height: 1000, originalWidth: 3000, originalHeight: 1500 });
		const out = sniffImage(Buffer.from(r.content[1].data, "base64"));
		expect(out).toMatchObject({ width: 2000, height: 1000 });
	});
	test("uses the model's own limits", async () => {
		const tool = buildTools(["read"], dir, [], { imageLimits: () => ({ maxWidth: 600, maxHeight: 600 }) })[0]!;
		const r = (await tool.execute("t", { path: "big.png" }, undefined as never)) as { content: any[]; details: any };
		expect(r.details).toMatchObject({ width: 600, height: 300 });
	});
	test("turns a picture upright when EXIF says it is rotated", async () => {
		const r = await read("turned.jpg");
		expect(r.details).toMatchObject({ resized: true, width: 20, height: 40 });
	});
	test("a picture that cannot be decoded and is too big to send as it is gets advice, not an error", async () => {
		for (const name of ["wide.jpg", "corrupt.png"]) {
			const r = await read(name);
			expect(r.content).toHaveLength(1);
			expect(r.content[0].text).toContain("could not be resized");
			expect(r.details.shown).toBe(false);
		}
	});
	test("explains pictures in unsupported formats", async () => {
		const r = await read("x.bmp");
		expect(r.content[0].text).toContain("BMP");
		expect(r.content).toHaveLength(1);
	});
});

describe("resizeToFit", () => {
	test("keeps a picture that already fits at its size", async () => {
		const r = await resizeToFit(PNG);
		expect(r).toMatchObject({ width: 1, height: 1 });
	});
	test("steps quality and size down until it fits the byte limit", async () => {
		const r = await resizeToFit(noisePng(800, 800), { maxBytes: 60 * 1024 });
		expect(r).not.toBeNull();
		expect(Buffer.byteLength(r!.data)).toBeLessThan(60 * 1024);
	});
	test("returns null for bytes that are not a picture", async () => {
		expect(await resizeToFit(Buffer.from("not an image"))).toBeNull();
	});
});

describe("exifOrientation", () => {
	test("reads the tag from a JPEG and defaults to 1", () => {
		expect(exifOrientation(withOrientation(photonJpeg(8, 8), 6))).toBe(6);
		expect(exifOrientation(withOrientation(photonJpeg(8, 8), 3))).toBe(3);
		expect(exifOrientation(photonJpeg(8, 8))).toBe(1);
		expect(exifOrientation(PNG)).toBe(1);
	});
});
