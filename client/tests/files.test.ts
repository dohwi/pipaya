import { describe, expect, test } from "bun:test";
import { cleanWorkdirPath, fileRejection, filePathOf, isImagePath, isInlineImage, MAX_FILE_BYTES, MAX_FILES, MAX_FILES_TOTAL, isLocalFilePath, isWorkdirPath, parseTable, previewKind, sizeLabel } from "../src/lib/files";

import { readFileSync } from "node:fs";
import { extname } from "node:path";

// The server's extension -> type table, read as text: importing server/src would need the server's dependencies, which the client job does not install.
const serverSource = readFileSync(new URL("../../server/src/file-routes.ts", import.meta.url), "utf8");
const MIME: Record<string, string> = Object.fromEntries(
	[...(/const MIME: Record<string, string> = \{([\s\S]*?)\n\};/.exec(serverSource)?.[1] ?? "").matchAll(/([a-z0-9]+): "([^"]+)"/g)].map((m) => [m[1]!, m[2]!]),
);
const mimeOf = (file: string) => MIME[extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

test("the server type table was found (the preview-kind check below depends on it)", () => {
	expect(Object.keys(MIME).length).toBeGreaterThan(20);
	expect(mimeOf("a.png")).toBe("image/png");
	expect(mimeOf("a.unknown")).toBe("application/octet-stream");
});

describe("working-directory links", () => {
	test("only relative paths inside the directory count", () => {
		for (const ok of ["out/report.pdf", "./a.png", "a b.txt", "x/y/z.csv#L3"]) expect(isWorkdirPath(ok), ok).toBe(true);
		for (const bad of ["", "#top", "/etc/passwd", "//evil.example/x", "../secret", "a/../../b", "https://x.test/a.png", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.c", "file:///etc/passwd"]) {
			expect(isWorkdirPath(bad), bad).toBe(false);
		}
	});
	test("the query and fragment are dropped and escapes decoded", () => {
		expect(cleanWorkdirPath("./out/a%20b.png?x=1#y")).toBe("out/a b.png");
		expect(cleanWorkdirPath("out/%E0%A4%A")).toBe("out/%E0%A4%A");
	});
});

describe("previews", () => {
	test("kind follows the type, then the name", () => {
		expect(previewKind("a.png", "image/png")).toBe("image");
		expect(previewKind("a.JPG")).toBe("image");
		expect(previewKind("notes.md", "application/octet-stream")).toBe("markdown");
		expect(previewKind("a.csv", "text/csv")).toBe("table");
		expect(previewKind("a.mp3")).toBe("audio");
		expect(previewKind("a.mp4", "video/mp4")).toBe("video");
		expect(previewKind("index.html", "text/plain")).toBe("html");
		expect(previewKind("main.py")).toBe("text");
		expect(previewKind("data", "application/json")).toBe("text");
		expect(previewKind("a.pdf", "application/pdf")).toBe("pdf");
		expect(previewKind("a.zip", "application/zip")).toBe("other");
	});
	test("every supported extension gets its kind, with the type the server really sends", () => {
		const cases: Record<string, string[]> = {
			image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"],
			pdf: ["pdf"],
			audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"],
			video: ["mp4", "m4v", "webm", "ogv", "mov"],
			markdown: ["md", "markdown"],
			html: ["html", "htm"],
			table: ["csv", "tsv"],
			text: ["txt", "json", "log", "yml", "yaml", "toml", "ini", "xml", "css", "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "svelte", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "sh", "sql", "diff", "patch", "env"],
			other: ["zip", "docx", "xlsx", "pptx", "exe", "bin", "gz"],
		};
		for (const [kind, exts] of Object.entries(cases)) {
			for (const ext of exts) {
				const name = `file.${ext}`;
				expect(previewKind(name), `${name} (name only)`).toBe(kind);
				expect(previewKind(name.toUpperCase()), `${name} (upper case)`).toBe(kind);
				expect(previewKind(name, mimeOf(name)), `${name} (server type ${mimeOf(name)})`).toBe(kind);
			}
		}
	});
	test("an unknown extension is a download, a text type is still text", () => {
		expect(previewKind("README")).toBe("other");
		expect(previewKind("a.png.zip")).toBe("other");
		expect(previewKind("noext", "text/plain")).toBe("text");
		expect(previewKind("x.bin", "image/png")).toBe("image");
		expect(previewKind("x.heic", "image/heic")).toBe("other");
	});
	test("tables: quotes, escaped quotes, newlines in cells, BOM, row cap", () => {
		expect(parseTable('\uFEFFa,b\r\n"x,1","he said ""hi"""\n"l1\nl2",z', ",").rows).toEqual([["a", "b"], ["x,1", 'he said "hi"'], ["l1\nl2", "z"]]);
		expect(parseTable("a\tb\n1\t2", "\t").rows).toEqual([["a", "b"], ["1", "2"]]);
		const r = parseTable("1\n2\n3\n", ",", 2);
		expect(r.rows.length).toBe(2);
		expect(r.more).toBe(true);
	});
	test("sizes are short", () => {
		expect(sizeLabel(512)).toBe("512 B");
		expect(sizeLabel(2048)).toBe("2.0 KB");
		expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
		expect(sizeLabel(undefined)).toBe("");
	});

	test("a file on the server's disk is told apart from a relative path and a web URL", () => {
		for (const ok of ["/home/u/app/out/a.png", "file:///home/u/a.png", "C:\\work\\a.png", "D:/work/a.png"]) expect(isLocalFilePath(ok), ok).toBe(true);
		for (const no of ["out/a.png", "//cdn.example/a.png", "https://x.com/a.png", "#top", ""]) expect(isLocalFilePath(no), no).toBe(false);
		expect(filePathOf("file:///home/u/my%20shot.png")).toBe("/home/u/my shot.png");
		expect(filePathOf("file:///C:/work/a.png")).toBe("C:/work/a.png");
		expect(filePathOf("/home/u/a.png?x=1#y")).toBe("/home/u/a.png");
		expect(filePathOf("./out/a.png")).toBe("out/a.png");
	});
	test("image links are recognised by extension", () => {
		for (const ok of ["out/a.PNG", "/x/b.jpeg", "c.webp?raw=1", "d.svg#v"]) expect(isImagePath(ok), ok).toBe(true);
		for (const no of ["out/a.pdf", "a.png.zip", "README.md"]) expect(isImagePath(no), no).toBe(false);
	});
});

describe("attaching files to a message", () => {
	test("only pictures a vision model can see go in as images", () => {
		expect(isInlineImage({ type: "image/png" }, true)).toBe(true);
		expect(isInlineImage({ type: "image/png" }, false)).toBe(false);
		expect(isInlineImage({ type: "image/svg+xml" }, true)).toBe(false);
		expect(isInlineImage({ type: "application/pdf" }, true)).toBe(false);
	});
	test("a file that fits is accepted", () => {
		expect(fileRejection({ name: "a", size: 10 }, [{ size: 5 }])).toBeNull();
	});
	test("too many files stops the batch", () => {
		const full = Array.from({ length: MAX_FILES }, () => ({ size: 1 }));
		expect(fileRejection({ name: "a", size: 1 }, full)).toEqual({ reason: "count", stop: true });
	});
	test("an oversized file is skipped on its own", () => {
		expect(fileRejection({ name: "a", size: MAX_FILE_BYTES + 1 }, [])).toEqual({ reason: "size", stop: false });
	});
	test("the combined size is capped", () => {
		const big = [{ size: MAX_FILES_TOTAL - 5 }];
		expect(fileRejection({ name: "a", size: 10 }, big)).toEqual({ reason: "total", stop: false });
	});
});
