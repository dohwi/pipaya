import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

// DOMPurify needs a window when the module loads.
const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });
const { awaitsHighlight, isSafeExternalUrl, parseRuns, renderMarkdown, renderStreaming } = await import("../src/lib/markdown");
const { onHighlightReady } = await import("../src/lib/code-highlight");

const ready = () => new Promise<void>((resolve) => { const off = onHighlightReady(() => { off(); resolve(); }); });
const codeText = (html: string) => {
	const el = dom.document.createElement("div");
	el.innerHTML = html;
	return el.querySelector("code")?.textContent;
};

describe("code blocks in answers", () => {
	test("drawn plain while the grammar loads (not cached), then coloured; the code reads the same both times", async () => {
		const src = "```python\ndef f(x):\n    return x < 2  # <b>not bold</b>\n```";
		const done = ready();
		const first = renderMarkdown(src);
		expect(awaitsHighlight(first)).toBe(true);
		expect(first).not.toContain("hljs-");
		await done;
		const second = renderMarkdown(src);
		expect(awaitsHighlight(second)).toBe(false);
		expect(second).toContain('<span class="hljs-keyword">def</span>');
		expect(second).not.toContain("<b>");
		expect(codeText(second)).toBe(codeText(first));
		expect(codeText(second)).toBe("def f(x):\n    return x < 2  # <b>not bold</b>");
		// finished text is cached once coloured
		expect(renderMarkdown(src)).toBe(second);
	});

	test("plain text and unknown languages are never marked as waiting", () => {
		expect(awaitsHighlight(renderMarkdown("```\nplain\n```"))).toBe(false);
		expect(awaitsHighlight(renderMarkdown("```cobol\nDISPLAY 'HI'.\n```"))).toBe(false);
		expect(renderMarkdown("```text\n<script>alert(1)</script>\n```")).toContain("&lt;script&gt;");
	});

	test("while streaming, only finished code blocks are coloured; the one being written stays plain", async () => {
		renderMarkdown("```bash\necho warm\n```");
		await ready();
		const html = renderStreaming("intro\n\n```bash\necho done\n```\n\nmore\n\n```bash\necho still writ");
		const blocks = html.split("<pre>").slice(1);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("hljs-built_in");
		expect(blocks[1]).not.toContain("hljs-");
		expect(awaitsHighlight(html)).toBe(false);
	});

	test("frames that only grow the last block give the same HTML as rendering each frame from scratch", () => {
		const head = "# Title\n\nSome **bold** text.\n\n- a\n- b\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n";
		let src = head;
		const frames: string[] = [];
		for (const piece of ["Writ", "ing ", "on\n", "\nNext ", "para", "\n\n```\nco", "de\n", "```\n\nend"]) frames.push((src += piece));
		const seen = frames.map((f) => renderStreaming(f));
		// a frame drawn again on its own (no earlier frame to reuse) reads the same
		frames.forEach((f, i) => {
			renderStreaming("reset\n\nother");
			expect(renderStreaming(f)).toBe(seen[i]!);
		});
		expect(seen.at(-1)).toContain("<strong>bold</strong>");
		expect(seen.at(-1)).toContain("<td>2</td>");
		expect(seen.at(-1)).toContain("Next para");
	});

	test("a long answer with more blocks than the block cache holds renders each new block once, not the whole answer", () => {
		// 450 headings: more than the 400-entry block cache. Each frame that starts a new block used to evict the
		// first block, then miss on every lookup in turn and parse all of them again (150-290ms frames in a browser).
		const n = 450;
		let src = "";
		for (let i = 0; i < n - 10; i++) src += `## b${i}\n\n`;
		renderStreaming(`${src}tail`);
		const before = parseRuns.n;
		let last = "";
		for (let i = n - 10; i < n; i++) {
			src += `## b${i}\n\n`;
			last = renderStreaming(`${src}tail`);
		}
		// per frame: the one new settled block and the tail; a full re-render would be ~450 per frame
		expect(parseRuns.n - before).toBeLessThanOrEqual(20);
		// and the result is the answer rendered from scratch
		const settled = last;
		renderStreaming("reset\n\nother");
		expect(renderStreaming(`${src}tail`)).toBe(settled);
		expect(settled).toContain(`b${n - 1}`);
	});

	test("a code block waiting for its grammar in the settled part is drawn in colour once it arrives", async () => {
		const src = "intro\n\n```graphql\nquery Q { me { id } }\n```\n\nstill writ";
		const done = ready();
		const first = renderStreaming(src);
		expect(awaitsHighlight(first)).toBe(true);
		await done;
		const second = renderStreaming(src);
		expect(awaitsHighlight(second)).toBe(false);
		expect(second).toContain("hljs-");
	});
});

describe("external link schemes in markdown", () => {
	test("allows http, https, mailto and workdir file links while disarming custom or dangerous schemes", () => {
		expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
		expect(isSafeExternalUrl("http://100.85.51.107:8080/")).toBe(true);
		expect(isSafeExternalUrl("mailto:team@example.com")).toBe(true);
		for (const bad of ["javascript:alert(1)", "data:text/html,hi", "pipaya://connect?u=http://evil&c=12345678", "vscode://file/etc/passwd", "smb://host/share"]) {
			expect(isSafeExternalUrl(bad)).toBe(false);
			const out = renderMarkdown(`[open](${bad})`);
			expect(out).not.toContain("data-ext");
			expect(out).not.toContain("href=");
			expect(out).toContain("open");
		}

		const good = renderMarkdown("[site](https://example.com) and [doc](out/report.pdf)");
		expect(good).toContain('href="https://example.com"');
		expect(good).toContain('data-file="out/report.pdf"');
	});
});
