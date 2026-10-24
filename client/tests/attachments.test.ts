import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Attachments as AttachmentsType } from "../src/lib/attachments.svelte";

// Compile the real rune module with Svelte; the three modules it reaches for (limits, image decoding, translation) are
// replaced by small stand-ins so the test needs no browser: it checks the order, the numbering and the limits.
let Attachments: typeof AttachmentsType;
let releaseFiles: (list: { preview?: string }[]) => void;
let dir: string;
const MAX = { MAX_FILES: 2, MAX_FILE_BYTES: 100, MAX_FILES_TOTAL: 150, MAX_IMAGES: 2 };
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".attachments-"));
	const source = ts.transpileModule(await Bun.file(resolve("src/lib/attachments.svelte.ts")).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const code = compileModule(source, { filename: "attachments.svelte.js", generate: "client" }).js.code
		.replace('"./files"', '"./files.mjs"').replace('"./images"', '"./images.mjs"').replace('"./i18n"', '"./i18n.mjs"');
	await writeFile(join(dir, "attachments.mjs"), code);
	await writeFile(join(dir, "files.mjs"), `
export const MAX_FILES = ${MAX.MAX_FILES}, MAX_FILE_BYTES = ${MAX.MAX_FILE_BYTES}, MAX_FILES_TOTAL = ${MAX.MAX_FILES_TOTAL}, MAX_IMAGES = ${MAX.MAX_IMAGES};
export const isInlineImage = (f, vision) => vision && f.type.startsWith("image/");
export const fileRejection = (f, existing) => {
	if (existing.length >= MAX_FILES) return { reason: "count", stop: true };
	if (f.size > MAX_FILE_BYTES) return { reason: "size", stop: false };
	if (existing.reduce((n, x) => n + x.size, f.size) > MAX_FILES_TOTAL) return { reason: "total", stop: false };
	return null;
};
export const fileToDraft = async (f) => { if (f.name === "broken") throw new Error("x"); return { id: "f-" + f.name, name: f.name, size: f.size, preview: f.type.startsWith("image/") ? "blob:" + f.name : undefined }; };
`);
	await writeFile(join(dir, "images.mjs"), `export const fileToAttachment = async (f) => { if (f.name === "broken") throw new Error("x"); return { id: "i-" + f.name, name: f.name }; };`);
	await writeFile(join(dir, "i18n.mjs"), `export const t = (k, p) => k + (p ? JSON.stringify(p) : "");`);
	({ Attachments, releaseFiles } = await import(join(dir, "attachments.mjs")));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const file = (name: string, size = 10, type = "text/plain") => ({ name, size, type }) as File;
function host(vision = true) {
	const errors: string[] = [];
	const tokens: number[] = [];
	return { errors, tokens, h: { vision: () => vision, error: (m: string) => void errors.push(m), imageAdded: (n: number) => void tokens.push(n) } };
}

describe("Attachments.add", () => {
	test("a picture goes in as an image and asks for its #imageN token, numbered from 1", async () => {
		const { h, tokens } = host();
		const a = new Attachments(h);
		await a.add([file("a.png", 10, "image/png"), file("b.png", 10, "image/png")]);
		expect(a.images.map((x) => x.name)).toEqual(["a.png", "b.png"]);
		expect(tokens).toEqual([1, 2]);
		expect(a.files).toEqual([]);
	});
	test("a model that cannot see pictures gets them as plain files", async () => {
		const { h, tokens } = host(false);
		const a = new Attachments(h);
		await a.add([file("a.png", 10, "image/png")]);
		expect(a.images).toEqual([]);
		expect(a.files.map((x) => x.name)).toEqual(["a.png"]);
		expect(tokens).toEqual([]);
	});
	test("a third image is refused with a message and the rest still go through", async () => {
		const { h, errors } = host();
		const a = new Attachments(h);
		await a.add([file("1.png", 1, "image/png"), file("2.png", 1, "image/png"), file("3.png", 1, "image/png"), file("n.txt")]);
		expect(a.images).toHaveLength(2);
		expect(errors).toHaveLength(1);
		expect(a.files.map((x) => x.name)).toEqual(["n.txt"]);
	});
	test("a file over the size limit is refused, the next one is still tried", async () => {
		const { h, errors } = host();
		const a = new Attachments(h);
		await a.add([file("big.bin", 101), file("ok.txt")]);
		expect(a.files.map((x) => x.name)).toEqual(["ok.txt"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("big.bin");
	});
	test("the count limit stops the whole batch with one message", async () => {
		const { h, errors } = host();
		const a = new Attachments(h);
		await a.add([file("1"), file("2"), file("3"), file("4")]);
		expect(a.files.map((x) => x.name)).toEqual(["1", "2"]);
		expect(errors).toHaveLength(1);
	});
	test("the total size limit refuses the file that would cross it, not the ones before", async () => {
		const { h, errors } = host();
		const a = new Attachments(h);
		await a.add([file("a", 90), file("b", 90)]);
		expect(a.files.map((x) => x.name)).toEqual(["a"]);
		expect(errors).toHaveLength(1);
	});
	test("a file that cannot be read is reported by name and skipped", async () => {
		const { h, errors } = host();
		const a = new Attachments(h);
		await a.add([file("broken"), file("fine")]);
		expect(a.files.map((x) => x.name)).toEqual(["fine"]);
		expect(errors[0]).toContain("broken");
	});
	test("an image that cannot be decoded is reported and does not take a number", async () => {
		const { h, errors, tokens } = host();
		const a = new Attachments(h);
		await a.add([file("broken", 1, "image/png"), file("ok.png", 1, "image/png")]);
		expect(a.images.map((x) => x.name)).toEqual(["ok.png"]);
		expect(tokens).toEqual([1]);
		expect(errors).toHaveLength(1);
	});
});

describe("removing and clearing", () => {
	test("removing an image returns its number so the caller can drop the token; unknown ids return null", async () => {
		const { h } = host();
		const a = new Attachments(h);
		await a.add([file("a.png", 1, "image/png"), file("b.png", 1, "image/png")]);
		expect(a.removeImage("i-b.png")).toBe(2);
		expect(a.images.map((x) => x.name)).toEqual(["a.png"]);
		expect(a.removeImage("nope")).toBeNull();
	});
	test("`any` is true while anything is attached", async () => {
		const { h } = host();
		const a = new Attachments(h);
		expect(a.any).toBe(false);
		await a.add([file("n.txt")]);
		expect(a.any).toBe(true);
		a.clear();
		expect(a.any).toBe(false);
	});
	test("clearing frees the thumbnails of the files", async () => {
		const { h } = host(false);
		const revoked: string[] = [];
		const orig = URL.revokeObjectURL;
		URL.revokeObjectURL = (u: string) => void revoked.push(u);
		try {
			const a = new Attachments(h);
			await a.add([file("a.png", 1, "image/png")]);
			a.clear();
			expect(revoked).toEqual(["blob:a.png"]);
		} finally { URL.revokeObjectURL = orig; }
	});
	test("removing one file frees only its thumbnail", async () => {
		const { h } = host(false);
		const revoked: string[] = [];
		const orig = URL.revokeObjectURL;
		URL.revokeObjectURL = (u: string) => void revoked.push(u);
		try {
			const a = new Attachments(h);
			await a.add([file("a.png", 1, "image/png"), file("b.png", 1, "image/png")]);
			a.removeFile("f-a.png");
			expect(revoked).toEqual(["blob:a.png"]);
			expect(a.files.map((x) => x.name)).toEqual(["b.png"]);
		} finally { URL.revokeObjectURL = orig; }
	});
	test("loading a stored draft does not free anything", () => {
		const { h } = host();
		const revoked: string[] = [];
		const orig = URL.revokeObjectURL;
		URL.revokeObjectURL = (u: string) => void revoked.push(u);
		try {
			const a = new Attachments(h);
			a.load([], [{ id: "x", name: "x", size: 1, preview: "blob:x" } as never]);
			a.load([], []);
			expect(revoked).toEqual([]);
			releaseFiles([{ preview: "blob:y" }]);
			expect(revoked).toEqual(["blob:y"]);
		} finally { URL.revokeObjectURL = orig; }
	});
});
