import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { BARE_URL_END, MARKED_OPTIONS, NO_INDENTED_CODE, bareUrlEnd } from "../src/lib/markdown-split";

const md = new Marked(MARKED_OPTIONS, NO_INDENTED_CODE, BARE_URL_END);
const html = (s: string) => (md.parse(s, { async: false }) as string).trim();

describe("bare URLs in Korean text", () => {
	test("stop before a particle and a closing paren", () => {
		expect(html("PR (https://github.com/dohwi/pipaya-extensions/pull/1)에 반영")).toBe(
			'<p>PR (<a href="https://github.com/dohwi/pipaya-extensions/pull/1">https://github.com/dohwi/pipaya-extensions/pull/1</a>)에 반영</p>',
		);
		expect(html("https://x.com/a에서 봄")).toBe('<p><a href="https://x.com/a">https://x.com/a</a>에서 봄</p>');
		expect(html("www.x.com/a에서")).toBe('<p><a href="http://www.x.com/a">www.x.com/a</a>에서</p>');
		expect(html("https://x.com/v1.2에서")).toBe('<p><a href="https://x.com/v1.2">https://x.com/v1.2</a>에서</p>');
	});
	test("stop at full-width and CJK punctuation", () => {
		expect(html("https://x.com/a）에서")).toBe('<p><a href="https://x.com/a">https://x.com/a</a>）에서</p>');
		expect(html("「https://x.com/a」라고")).toBe('<p>「<a href="https://x.com/a">https://x.com/a</a>」라고</p>');
	});
	test("keep non-ASCII path and query parts", () => {
		expect(bareUrlEnd("https://ko.wikipedia.org/wiki/서울")).toBe("https://ko.wikipedia.org/wiki/서울".length);
		expect(bareUrlEnd("https://x.com/검색?q=한글")).toBe("https://x.com/검색?q=한글".length);
	});
	test("leave GFM behaviour alone elsewhere", () => {
		expect(html("see https://x.com/a.")).toBe('<p>see <a href="https://x.com/a">https://x.com/a</a>.</p>');
		expect(html("(https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
			'<p>(<a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>)</p>',
		);
		expect(html("foo@bar.com에게")).toBe('<p><a href="mailto:foo@bar.com">foo@bar.com</a>에게</p>');
		expect(html("<https://x.com/a>에")).toBe('<p><a href="https://x.com/a">https://x.com/a</a>에</p>');
	});
});
