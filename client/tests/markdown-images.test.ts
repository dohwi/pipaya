import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { remoteImageHost } from "../src/lib/remote-image";
import { blocksOf, streamSplit } from "../src/lib/markdown-split";

// DOMPurify needs a window when markdown.ts loads.
const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });
const { renderMarkdown } = await import("../src/lib/markdown");

function parseHtml(html: string) {
	const el = dom.document.createElement("div");
	el.innerHTML = html;
	return el;
}

describe("remoteImageHost", () => {
	test("offers only http(s) images, reporting the host that would be contacted", () => {
		expect(remoteImageHost("https://evil.example/x.png?d=secret")).toBe("evil.example");
		expect(remoteImageHost("http://10.0.0.1:8080/a.png")).toBe("10.0.0.1:8080");
	});
	test("everything else is not loadable", () => {
		for (const href of ["javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "file:///etc/passwd", "//evil.example/x.png", "x.png", ""]) {
			expect(remoteImageHost(href), href).toBeNull();
		}
	});
});

describe("streaming split", () => {
	test("cuts before the block being written, never inside one", () => {
		const s = "para one\n\n- a\n- b\n\n```js\nco";
		expect(s.slice(streamSplit(s))).toBe("```js\nco");
		expect(blocksOf(s.slice(0, streamSplit(s)))).toEqual(["para one", "- a\n- b"]);
	});
	test("does not split what cannot be rendered in pieces", () => {
		expect(streamSplit("only one block")).toBe(0);
		expect(streamSplit("")).toBe(0);
		// a reference definition below changes how a link above renders
		expect(streamSplit("text [r]\n\n[r]: http://x\n\nmore")).toBe(0);
	});
});

describe("inline image and media deduplication", () => {
	test("image followed by plain link to the same workdir image renders one wd-img and one wd-file link", () => {
		const html = renderMarkdown("![chart](out/a.png)\n\n[out/a.png](out/a.png)");
		const root = parseHtml(html);
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(1);
		expect(root.querySelector("span.wd-img")?.getAttribute("data-wd-src")).toBe("out/a.png");
		expect(root.querySelector(".gallery")).toBeNull();
		const links = root.querySelectorAll("a.wd-file");
		expect(links).toHaveLength(1);
		expect(links[0]?.getAttribute("data-file")).toBe("out/a.png");
		expect(links[0]?.textContent).toBe("out/a.png");
	});

	test("plain link appearing before image embed still falls back to wd-file so the image renders once", () => {
		const html = renderMarkdown("Saved to [out/a.png](out/a.png).\n\n![chart](out/a.png)");
		const root = parseHtml(html);
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(1);
		expect(root.querySelector("span.wd-img")?.getAttribute("data-alt")).toBe("chart");
		const links = root.querySelectorAll("a.wd-file");
		expect(links).toHaveLength(1);
		expect(links[0]?.getAttribute("data-file")).toBe("out/a.png");
	});

	test("normalizes ./ prefix, query/hash, and encoded spaces when deduplicating", () => {
		for (const src of [
			"![a](./out/a.png)\n\n[a](out/a.png)",
			"[a](./out/a.png)\n\n![a](out/a.png)",
			"![a](out/a.png?v=1#top)\n\n[a](out/a.png#bottom)",
			"![a](out/my%20chart.png)\n\n[a](<out/my chart.png>)",
		]) {
			const root = parseHtml(renderMarkdown(src));
			expect(root.querySelectorAll("span.wd-img"), src).toHaveLength(1);
			expect(root.querySelectorAll("a.wd-file"), src).toHaveLength(1);
		}
	});

	test("local absolute and file:// paths deduplicate without emitting a second wd-img or external link", () => {
		for (const src of [
			"![a](/tmp/a.png)\n\n[open](file:///tmp/a.png)",
			"[open](file:///tmp/a.png)\n\n![a](/tmp/a.png)",
		]) {
			const root = parseHtml(renderMarkdown(src));
			expect(root.querySelectorAll("span.wd-img"), src).toHaveLength(1);
			expect(root.querySelector("span.wd-img")?.getAttribute("data-wd-src")).toBe("/tmp/a.png");
			expect(root.querySelectorAll("a"), src).toHaveLength(0);
			expect(root.textContent).toContain("open");
		}
	});

	test("standalone image link with no image embed still renders inline", () => {
		const root = parseHtml(renderMarkdown("See [chart](out/a.png)"));
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(1);
		expect(root.querySelector("span.wd-img")?.getAttribute("data-wd-src")).toBe("out/a.png");
		expect(root.querySelectorAll("a.wd-file")).toHaveLength(0);
	});

	test("repeated plain links to the same image without an image embed render inline once then fall back to wd-file", () => {
		const root = parseHtml(renderMarkdown("See [first](out/a.png) and [second](out/a.png)"));
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(1);
		const links = root.querySelectorAll("a.wd-file");
		expect(links).toHaveLength(1);
		expect(links[0]?.textContent).toBe("second");
	});

	test("intentional duplicate image embeds via ![]() twice still render both pictures", () => {
		const root = parseHtml(renderMarkdown("![one](out/a.png)\n\n![two](out/a.png)"));
		const imgs = root.querySelectorAll("span.wd-img");
		expect(imgs).toHaveLength(2);
		expect(imgs[0]?.getAttribute("data-alt")).toBe("one");
		expect(imgs[1]?.getAttribute("data-alt")).toBe("two");
	});

	test("different images each render inline", () => {
		const root = parseHtml(renderMarkdown("![a](out/a.png)\n\n[b](out/b.png)"));
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(2);
		expect(root.querySelectorAll("a.wd-file")).toHaveLength(0);
	});

	test("media links deduplicate with media embeds in both orders while standalone media links still render inline", () => {
		for (const src of [
			"![clip](out/demo.mp4)\n\n[demo.mp4](out/demo.mp4)",
			"[demo.mp4](out/demo.mp4)\n\n![clip](out/demo.mp4)",
		]) {
			const root = parseHtml(renderMarkdown(src));
			expect(root.querySelectorAll("span.wd-media"), src).toHaveLength(1);
			expect(root.querySelector("span.wd-media")?.getAttribute("data-kind")).toBe("video");
			expect(root.querySelectorAll("a.wd-file"), src).toHaveLength(1);
		}
		const solo = parseHtml(renderMarkdown("[demo.mp4](out/demo.mp4)"));
		expect(solo.querySelectorAll("span.wd-media")).toHaveLength(1);
		expect(solo.querySelectorAll("a.wd-file")).toHaveLength(0);
	});

	test("image wrapped inside a link to itself renders one unwrapped wd-img", () => {
		const root = parseHtml(renderMarkdown("[![chart](out/a.png)](out/a.png)"));
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(1);
		expect(root.querySelector("span.wd-img")?.getAttribute("data-alt")).toBe("chart");
		expect(root.querySelectorAll("a")).toHaveLength(0);
	});

	test("deduplicates when the image embed is nested inside a list, blockquote, or table", () => {
		const root = parseHtml(renderMarkdown("Link: [out/a.png](out/a.png)\n\n- item\n  ![a](out/a.png)"));
		expect(root.querySelectorAll("span.wd-img")).toHaveLength(1);
		expect(root.querySelectorAll("a.wd-file")).toHaveLength(1);
	});
});
