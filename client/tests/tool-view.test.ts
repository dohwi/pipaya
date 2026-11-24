import { describe, expect, test } from "bun:test";
import { formatKvArgs, parseGrepOutput, parseLsOutput, tryPrettyJson } from "../src/lib/tool-view";

describe("parseGrepOutput", () => {
	test("handles empty and No matches", () => {
		expect(parseGrepOutput("")).toEqual({ groups: [], moreNote: "", empty: true });
		expect(parseGrepOutput("No matches")).toEqual({ groups: [], moreNote: "", empty: true });
	});

	test("groups path:line:text matches by file and extracts trailing more note", () => {
		const out = "src/a.ts:10:const x = 1;\nsrc/a.ts:24:return x;\nsrc/b.ts:3:import { x } from './a';\n[12 more matches]";
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
			moreNote: "12 more matches",
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
		expect(parseLsOutput("")).toEqual({ entries: [], empty: true });
		expect(parseLsOutput("(empty)")).toEqual({ entries: [], empty: true });
	});

	test("distinguishes directories and joins basePath", () => {
		expect(parseLsOutput("src/\nREADME.md\npackage.json", "client/")).toEqual({
			entries: [
				{ name: "src", fullPath: "client/src", isDir: true },
				{ name: "README.md", fullPath: "client/README.md", isDir: false },
				{ name: "package.json", fullPath: "client/package.json", isDir: false },
			],
			empty: false,
		});
		expect(parseLsOutput("a.ts", ".")).toEqual({
			entries: [{ name: "a.ts", fullPath: "a.ts", isDir: false }],
			empty: false,
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
