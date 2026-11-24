import { describe, expect, test } from "bun:test";
import { languageFromPath, splitHighlightedLines } from "../src/lib/code-highlight";
import { computeLineDiff, lineCount } from "../src/lib/line-diff";

describe("computeLineDiff", () => {
	test("handles empty strings and identical inputs", () => {
		expect(computeLineDiff("", "")).toEqual({ rows: [], added: 0, removed: 0 });
		const same = computeLineDiff("a\nb", "a\nb");
		expect(same.added).toBe(0);
		expect(same.removed).toBe(0);
		expect(same.rows).toEqual([
			{ kind: "ctx", oldLine: 1, newLine: 1, text: "a" },
			{ kind: "ctx", oldLine: 2, newLine: 2, text: "b" },
		]);
	});

	test("handles pure additions and pure deletions", () => {
		const added = computeLineDiff("", "one\ntwo");
		expect(added.added).toBe(2);
		expect(added.removed).toBe(0);
		expect(added.rows.map((r) => r.kind)).toEqual(["add", "add"]);

		const removed = computeLineDiff("one\ntwo", "");
		expect(removed.added).toBe(0);
		expect(removed.removed).toBe(2);
		expect(removed.rows.map((r) => r.kind)).toEqual(["del", "del"]);
	});

	test("computes minimal line-level diff with line numbers", () => {
		const diff = computeLineDiff("const a = 1;\nconst b = 2;\nconst c = 3;", "const a = 1;\nconst b = 20;\nconst d = 4;\nconst c = 3;");
		expect(diff.removed).toBe(1);
		expect(diff.added).toBe(2);
		expect(diff.rows).toEqual([
			{ kind: "ctx", oldLine: 1, newLine: 1, text: "const a = 1;" },
			{ kind: "del", oldLine: 2, newLine: null, text: "const b = 2;" },
			{ kind: "add", oldLine: null, newLine: 2, text: "const b = 20;" },
			{ kind: "add", oldLine: null, newLine: 3, text: "const d = 4;" },
			{ kind: "ctx", oldLine: 3, newLine: 4, text: "const c = 3;" },
		]);
	});

	test("normalizes CRLF and collapses long unchanged context runs", () => {
		const oldLines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
		const newLines = [...oldLines];
		newLines[1] = "line 2 edited";
		newLines[13] = "line 14 edited";
		const diff = computeLineDiff(oldLines.join("\r\n"), newLines.join("\n"));
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(2);
		const skips = diff.rows.filter((r) => r.kind === "skip");
		expect(skips).toEqual([{ kind: "skip", count: 5 }]);
	});

	test("counts lines accurately", () => {
		expect(lineCount("")).toBe(0);
		expect(lineCount("a")).toBe(1);
		expect(lineCount("a\nb\r\nc")).toBe(3);
	});
});

describe("languageFromPath & splitHighlightedLines", () => {
	test("maps paths, extensions and special filenames", () => {
		expect(languageFromPath("src/components/ToolCard.svelte")).toBe("xml");
		expect(languageFromPath("server/src/tools.ts")).toBe("typescript");
		expect(languageFromPath("scripts/ui-lint.py")).toBe("python");
		expect(languageFromPath("deploy/Dockerfile")).toBe("dockerfile");
		expect(languageFromPath("deploy/Dockerfile.prod")).toBe("dockerfile");
		expect(languageFromPath(".env.local")).toBe("bash");
		expect(languageFromPath("README")).toBeNull();
		expect(languageFromPath("")).toBeNull();
	});

	test("balances spans that cross newlines", () => {
		const html = '<span class="hljs-comment">/* start\nmiddle\nend */</span>\n<span class="hljs-keyword">const</span> x = 1;';
		expect(splitHighlightedLines(html)).toEqual([
			'<span class="hljs-comment">/* start</span>',
			'<span class="hljs-comment">middle</span>',
			'<span class="hljs-comment">end */</span>',
			'<span class="hljs-keyword">const</span> x = 1;',
		]);
	});
});
