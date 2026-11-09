import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { patchHtml } from "../src/lib/patch-html";

/**
 * The DOM the action runs against. `patchHtml` only uses template/content/childNodes/attributes, but the comparison
 * itself (which node survived) needs a real DOM, so the test brings a minimal one.
 */
const dom = new Window();
(globalThis as { document?: unknown }).document = dom.document;

const host = () => {
	const el = dom.document.createElement("div");
	return el;
};

describe("patchHtml", () => {
	test("keeps the nodes that did not change", () => {
		const el = host();
		patchHtml(el, "<p>one</p><p>two</p>");
		const first = el.childNodes[0];
		patchHtml(el, "<p>one</p><p>two and more</p>").update("<p>one</p><p>two and more</p>");
		expect(el.childNodes[0]).toBe(first);
		expect(el.textContent).toBe("onetwo and more");
	});

	test("merges the block being written in place instead of rebuilding it", () => {
		// A streaming list: the item count and the last item's text grow every frame. The old top-level patch replaced
		// the whole <ul> each time, which is what made WebKit re-lay-out and re-paint it every frame.
		const el = host();
		patchHtml(el, "<ul><li>a</li><li>b</li></ul>");
		const ul = el.childNodes[0]!;
		const firstLi = ul.childNodes[0]!;
		const text = firstLi.childNodes[0]!;
		const action = patchHtml(el, "<ul><li>a</li><li>b</li></ul>");
		action.update("<ul><li>a</li><li>b and more</li><li>c</li></ul>");
		expect(el.childNodes[0]).toBe(ul);
		expect(ul.childNodes[0]).toBe(firstLi);
		expect(firstLi.childNodes[0]).toBe(text);
		expect(el.textContent).toBe("ab and morec");
	});

	test("updates attributes in place and drops the ones that are gone", () => {
		const el = host();
		const action = patchHtml(el, '<a href="/a" title="t">x</a>');
		const a = el.childNodes[0] as Element;
		action.update('<a href="/b">x</a>');
		expect(el.childNodes[0]).toBe(a);
		expect(a.getAttribute("href")).toBe("/b");
		expect(a.hasAttribute("title")).toBe(false);
	});

	test("replaces a node whose kind changed and removes the tail", () => {
		const el = host();
		const action = patchHtml(el, "<p>text</p><p>second</p>");
		const first = el.childNodes[0]!;
		action.update("<h2>text</h2>");
		expect(el.childNodes.length).toBe(1);
		expect(el.childNodes[0]).not.toBe(first);
		expect(el.innerHTML).toBe("<h2>text</h2>");
	});

	test("a settled answer is left exactly as rendered", () => {
		const el = host();
		const html = "<p>one <strong>bold</strong></p><div class=\"codeblock\"><pre><code>a\nb</code></pre></div>";
		const action = patchHtml(el, html);
		const before = el.innerHTML;
		action.update(html);
		expect(el.innerHTML).toBe(before);
	});
});
