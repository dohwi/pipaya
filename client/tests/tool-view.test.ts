import { describe, expect, test } from "bun:test";
import { formatKvArgs, parseGrepOutput, parseLsOutput, parseReadOutput, tryPrettyJson } from "../src/lib/tool-view";

describe("parseGrepOutput", () => {
	test("handles empty, No matches and (no matches)", () => {
		expect(parseGrepOutput("")).toEqual({ groups: [], moreNote: "", empty: true });
		expect(parseGrepOutput("No matches")).toEqual({ groups: [], moreNote: "", empty: true });
		expect(parseGrepOutput("(no matches)")).toEqual({ groups: [], moreNote: "", empty: true });
	});

	test("groups path:line:text matches by file and extracts trailing more notes", () => {
		const out = "src/a.ts:10:const x = 1;\nsrc/a.ts:24:return x;\nsrc/b.ts:3:import { x } from './a';\n[12 more matches omitted]\n[warning: partial results (permission denied)]";
		expect(parseGrepOutput(out)).toEqual({
			groups: [
				{
					path: "src/a.ts",
					hits: [
						{ line: 10, text: "const x = 1;" },
						{ line: 24, text: "return x;" },
					],
				},
				{
					path: "src/b.ts",
					hits: [{ line: 3, text: "import { x } from './a';" }],
				},
			],
			moreNote: "12 more matches omitted · warning: partial results (permission denied)",
			empty: false,
		});
	});

	test("handles context lines (-C) and files-only (-l) output", () => {
		const ctxOut = "src/a.ts-9-before\nsrc/a.ts:10:match\n--\nsrc/b.ts:2:hit";
		expect(parseGrepOutput(ctxOut)).toEqual({
			groups: [
				{
					path: "src/a.ts",
					hits: [
						{ line: 9, text: "before" },
						{ line: 10, text: "match" },
					],
				},
				{ path: "src/b.ts", hits: [{ line: 2, text: "hit" }] },
			],
			moreNote: "",
			empty: false,
		});

		expect(parseGrepOutput("src/a.ts\nsrc/b.ts")).toEqual({
			groups: [
				{ path: "src/a.ts", hits: [] },
				{ path: "src/b.ts", hits: [] },
			],
			moreNote: "",
			empty: false,
		});
	});

	test("falls back cleanly for lines without path:line prefix", () => {
		const parsed = parseGrepOutput("plain match line");
		expect(parsed.empty).toBe(false);
		expect(parsed.groups).toEqual([{ path: "", hits: [{ line: null, text: "plain match line" }] }]);
	});
});

describe("parseLsOutput", () => {
	test("handles empty and (empty)", () => {
		expect(parseLsOutput("")).toEqual({ entries: [], moreNote: "", empty: true });
		expect(parseLsOutput("(empty)")).toEqual({ entries: [], moreNote: "", empty: true });
	});

	test("distinguishes directories, joins basePath, and extracts trailing omitted note", () => {
		expect(parseLsOutput("src/\nREADME.md\npackage.json\n[5 more entries omitted]", "client/")).toEqual({
			entries: [
				{ name: "src", fullPath: "client/src", isDir: true },
				{ name: "README.md", fullPath: "client/README.md", isDir: false },
				{ name: "package.json", fullPath: "client/package.json", isDir: false },
			],
			moreNote: "5 more entries omitted",
			empty: false,
		});
		expect(parseLsOutput("a.ts", ".")).toEqual({
			entries: [{ name: "a.ts", fullPath: "a.ts", isDir: false }],
			moreNote: "",
			empty: false,
		});
	});
});

describe("parseReadOutput", () => {
	test("returns null for empty and meta notices", () => {
		expect(parseReadOutput("")).toBeNull();
		expect(parseReadOutput("(empty file)")).toBeNull();
		expect(parseReadOutput("(file has 10 lines; offset 20 is past EOF)")).toBeNull();
	});

	test("strips server numbered-line prefixes and keeps actual line numbers", () => {
		const out = "  10│const a = 1;\n  11│const b = 2;\n[5 more lines; continue with offset=12]";
		expect(parseReadOutput(out, 1)).toEqual({
			code: "const a = 1;\nconst b = 2;",
			lines: [
				{ lineNo: 10, text: "const a = 1;" },
				{ lineNo: 11, text: "const b = 2;" },
			],
			moreNote: "5 more lines; continue with offset=12",
		});
	});

	test("falls back to sequential numbering for unnumbered legacy output", () => {
		expect(parseReadOutput("hello\nworld", 5)).toEqual({
			code: "hello\nworld",
			lines: [
				{ lineNo: 5, text: "hello" },
				{ lineNo: 6, text: "world" },
			],
			moreNote: "",
		});
	});
});

describe("formatKvArgs", () => {
	test("preserves falsy primitives, skips undefined/empty, supports omitKeys", () => {
		expect(
			formatKvArgs(
				{ action: "inspect", offset: 0, enabled: false, empty: "", missing: undefined, nil: null, patterns: ["a", "b"] },
				["action"],
			),
		).toEqual([
			{ key: "offset", value: "0", multiline: false },
			{ key: "enabled", value: "false", multiline: false },
			{ key: "nil", value: "null", multiline: false },
			{ key: "patterns", value: "a, b", multiline: false },
		]);
	});

	test("marks multiline strings and nested objects as multiline", () => {
		const rows = formatKvArgs({ content: "line1\nline2", meta: { a: 1 } });
		expect(rows[0]).toEqual({ key: "content", value: "line1\nline2", multiline: true });
		expect(rows[1]?.key).toBe("meta");
		expect(rows[1]?.multiline).toBe(true);
	});
});

describe("tryPrettyJson", () => {
	test("pretty-prints valid JSON objects and arrays, ignores primitives and plain text", () => {
		expect(tryPrettyJson('{"ok":true,"n":2}')).toBe('{\n  "ok": true,\n  "n": 2\n}');
		expect(tryPrettyJson("[1,2]")).toBe("[\n  1,\n  2\n]");
		expect(tryPrettyJson("plain text")).toBeNull();
		expect(tryPrettyJson("123")).toBeNull();
		expect(tryPrettyJson("{broken")).toBeNull();
	});
});
