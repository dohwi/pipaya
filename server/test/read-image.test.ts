import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnsupportedPicture, sniffImage } from "../src/image-file.ts";
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

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-readimg-"));
	writeFileSync(join(dir, "a.png"), PNG);
	writeFileSync(join(dir, "renamed.txt"), PNG);
	writeFileSync(join(dir, "fake.png"), "just text\nsecond line\n");
	writeFileSync(join(dir, "pic.gif"), GIF);
	writeFileSync(join(dir, "wide.jpg"), jpeg(9000, 100));
	writeFileSync(join(dir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]));
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
	test("refuses oversized files and dimensions with advice", async () => {
		const big = await read("huge.png");
		expect(big.content).toHaveLength(1);
		expect(big.content[0].text).toContain("limit");
		const wide = await read("wide.jpg");
		expect(wide.content).toHaveLength(1);
		expect(wide.content[0].text).toContain("larger than");
	});
	test("explains pictures in unsupported formats", async () => {
		const r = await read("x.bmp");
		expect(r.content[0].text).toContain("BMP");
		expect(r.content).toHaveLength(1);
	});
});
