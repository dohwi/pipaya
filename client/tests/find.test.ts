import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { findRanges, matchesIn } from "../src/lib/find";

describe("matchesIn", () => {
	test("finds every occurrence, ignoring case", () => {
		expect(matchesIn("Foo foo FOO", "foo")).toEqual([[0, 3], [4, 7], [8, 11]]);
	});
	test("does not overlap matches", () => {
		expect(matchesIn("aaaa", "aa")).toEqual([[0, 2], [2, 4]]);
	});
	test("empty query matches nothing", () => {
		expect(matchesIn("abc", "")).toEqual([]);
	});
	test("works with Korean text", () => {
		expect(matchesIn("대화 검색, 세션 내 검색", "검색")).toEqual([[3, 5], [12, 14]]);
	});
});

describe("findRanges", () => {
	const dom = new Window();
	const host = (html: string) => {
		const el = dom.document.createElement("div");
		el.innerHTML = html;
		return el as unknown as Node;
	};
	const texts = (rs: Range[]) => rs.map((r) => r.toString());

	test("finds text that syntax colours split across spans inside one code block", () => {
		const root = host('<pre><code><span class="hljs-keyword">if</span> (!res.<span class="hljs-title">ok</span>) <span class="hljs-keyword">throw</span></code></pre>');
		expect(texts(findRanges(root, "res.ok"))).toEqual(["res.ok"]);
		expect(texts(findRanges(root, "IF (!")).map((s) => s.toLowerCase())).toEqual(["if (!"]);
		expect(texts(findRanges(root, "ok) throw"))).toEqual(["ok) throw"]);
		expect(texts(findRanges(root, "if"))).toEqual(["if"]);
	});

	test("a match never runs from one code block, or from prose, into another", () => {
		const root = host("<p>ab</p><pre><code>cd</code></pre><pre><code>ef</code></pre><p>gh</p>");
		for (const q of ["bc", "de", "fg"]) expect(findRanges(root, q), q).toEqual([]);
		expect(texts(findRanges(root, "cd"))).toEqual(["cd"]);
	});

	test("outside code, matching stays inside one text node as before", () => {
		const root = host("<p>foo <b>bar</b> foo</p>");
		expect(texts(findRanges(root, "foo"))).toEqual(["foo", "foo"]);
		expect(findRanges(root, "o b")).toEqual([]);
		expect(findRanges(root, "  ")).toEqual([]);
	});

	test("stops at the limit", () => {
		const root = host(`<pre><code>${"<span>a</span>".repeat(10)}</code></pre>`);
		expect(findRanges(root, "a", 3)).toHaveLength(3);
	});
});
