import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { MARKED_OPTIONS, NO_INDENTED_CODE, blocksOf, hideFenceTail, hideMarkerTail, streamSplit } from "../src/lib/markdown-split";

const code = "text\n\n```ts\nfunction f() {\n  return 1;\n}\n";

describe("hideFenceTail", () => {
	test("hides a closing fence that is still being typed", () => {
		expect(hideFenceTail(`${code}\``)).toBe(code.slice(0, -1));
		expect(hideFenceTail(`${code}\`\``)).toBe(code.slice(0, -1));
	});
	test("keeps a complete fence and ordinary text", () => {
		expect(hideFenceTail(`${code}\`\`\``)).toBe(`${code}\`\`\``);
		expect(hideFenceTail("a `b")).toBe("a `b");
		expect(hideFenceTail("one\n\n`")).toBe("one\n\n`");
	});
});

describe("hideMarkerTail", () => {
	test("hides a block marker that has no text after it yet", () => {
		for (const m of ["#", "##", "-", "1.", "2", ">", "--", "|", "| a |\n|-"]) {
			const out = hideMarkerTail(`para\n\n${m}`);
			expect(out === "para\n" || out === "para\n\n" || out === "para" || out.startsWith("para")).toBe(true);
			expect(out.endsWith(m)).toBe(false);
		}
	});
	test("keeps text that follows a marker and code contents", () => {
		expect(hideMarkerTail("para\n\n## Title")).toBe("para\n\n## Title");
		expect(hideMarkerTail("para\n\n- item")).toBe("para\n\n- item");
		expect(hideMarkerTail("```\n-")).toBe("```\n-");
		expect(hideMarkerTail("a - b")).toBe("a - b");
	});
});

describe("no indented code blocks", () => {
	const md = new Marked(MARKED_OPTIONS, NO_INDENTED_CODE);
	const html = (s: string) => md.parse(s, { async: false });

	test("a list or paragraph indented by four spaces renders as itself, not as code", () => {
		expect(html("Steps:\n\n    1. first\n    2. second\n\nend")).toBe("<p>Steps:</p>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n<p>end</p>\n");
		expect(html("text\n\n    an indented **bold** paragraph")).toBe("<p>text</p>\n<p>an indented <strong>bold</strong> paragraph</p>\n");
		expect(html("x\n\n\t- tab indented")).toBe("<p>x</p>\n<ul>\n<li>tab indented</li>\n</ul>\n");
		expect(html("x\n\n            twelve spaces")).toBe("<p>x</p>\n<p>twelve spaces</p>\n");
	});

	test("fenced code still is code, indented or not", () => {
		expect(html("```js\nconst a = 1;\n```")).toContain('<code class="language-js">const a = 1;');
		expect(html("p\n\n    ```js\n    const a = 1;\n    ```\n\nq")).toBe('<p>p</p>\n<pre><code class="language-js">const a = 1;\n</code></pre>\n<p>q</p>\n');
	});

	test("raw HTML in an indented block is HTML again, for the sanitizer to judge", () => {
		expect(html("x\n\n    <b>hi</b>")).toBe("<p>x</p>\n<p><b>hi</b></p>\n");
	});

	test("nothing changes for text without four-space indents", () => {
		const doc = "## Title\n\nText **bold** `code` [l](https://x)\n\n- a\n  - b\n\n> quote\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
		expect(html(doc)).toBe(new Marked(MARKED_OPTIONS).parse(doc, { async: false }) as string);
	});

	test("empty and blank input render nothing", () => {
		expect(html("")).toBe("");
		expect(html("    ")).toBe("");
		expect(html("     \n\n    \n")).toBe("");
	});

	test("a streaming split through an indented block joins into the full render", () => {
		const s = "para\n\n    1. a\n    2. b\n\n    more text\n\ntail being wr";
		const cut = streamSplit(s);
		expect(cut).toBeGreaterThan(0);
		expect(blocksOf(s.slice(0, cut)).map(html).join("") + html(s.slice(cut))).toBe(html(s));
	});

	test("a reference definition inside an indented block stops the split", () => {
		expect(streamSplit("see [t][r]\n\n    [r]: https://x\n\nmore")).toBe(0);
	});

	test("an unfinished fence or marker inside an indented block is hidden while streaming", () => {
		expect(hideFenceTail("x\n\n    ```js\n    a\n    `")).toBe("x\n\n    ```js\n    a");
		expect(hideFenceTail("x\n\n    ```js\n    a\n    ```")).toBe("x\n\n    ```js\n    a\n    ```");
		expect(hideMarkerTail("x\n\n    1. a\n    2.")).toBe("x\n\n    1. a");
		expect(hideMarkerTail("x\n\n    ```\n    -")).toBe("x\n\n    ```\n    -");
	});
});
