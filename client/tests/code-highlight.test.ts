import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { MAX_HIGHLIGHT_CHARS, highlightCode, languageOf, onHighlightReady, preloadLanguage } from "../src/lib/code-highlight";

/** Resolves on the next "a grammar finished loading" signal. */
const ready = () => new Promise<void>((resolve) => { const off = onHighlightReady(() => { off(); resolve(); }); });

describe("languageOf", () => {
	test("fence labels models write map to the grammar that draws them", () => {
		expect(languageOf("ts")).toBe("typescript");
		expect(languageOf("TSX")).toBe("typescript");
		expect(languageOf(" js ")).toBe("javascript");
		expect(languageOf("sh")).toBe("bash");
		expect(languageOf("py")).toBe("python");
		expect(languageOf("yml")).toBe("yaml");
		expect(languageOf("html")).toBe("xml");
		expect(languageOf("c++")).toBe("cpp");
		expect(languageOf("rust")).toBe("rust");
	});
	test("no label, an unknown one, or an inherited property name is plain text", () => {
		for (const label of ["", "   ", null, undefined, "text", "brainfuck", "constructor", "__proto__", "toString"]) expect(languageOf(label), String(label)).toBeNull();
	});
});

describe("highlightCode", () => {
	test("plain text needs nothing loaded", () => {
		expect(highlightCode("a < b", "")).toBeNull();
		expect(highlightCode("a < b", "nope")).toBeNull();
		expect(highlightCode("", "ts")).toBeNull();
	});

	test("the first block of a language waits for its grammar, then is coloured with its text escaped", async () => {
		const done = ready();
		expect(highlightCode("const a = 1;", "ts")).toBe("wait");
		// asking again while it loads does not start a second fetch, and still waits
		expect(highlightCode("const b = 2;", "typescript")).toBe("wait");
		await done;
		const html = highlightCode('const a = "<img src=x onerror=alert(1)>" & 1; // ok', "ts")!;
		expect(html).toContain('<span class="hljs-keyword">const</span>');
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img");
		// the text is all there, as written
		const dom = new Window();
		const el = dom.document.createElement("code");
		el.innerHTML = html;
		expect(el.textContent).toBe('const a = "<img src=x onerror=alert(1)>" & 1; // ok');
	});

	test("a block too big for one pass stays plain", async () => {
		preloadLanguage("json");
		await ready();
		expect(highlightCode("{\"a\": 1}", "json")).toContain("hljs-number");
		expect(highlightCode(`[${"1,".repeat(MAX_HIGHLIGHT_CHARS)}1]`, "json")).toBeNull();
	});

	test("each listener hears a load once and can stop listening", async () => {
		let calls = 0;
		const off = onHighlightReady(() => calls++);
		const done = ready();
		preloadLanguage("go");
		await done;
		expect(calls).toBe(1);
		off();
		const next = ready();
		preloadLanguage("rust");
		await next;
		expect(calls).toBe(1);
		// an already loaded grammar is not fetched again: no new signal
		preloadLanguage("go");
		expect(highlightCode("package main", "golang")).toContain("hljs-keyword");
	});
});
