<script lang="ts">
	import { onDestroy, tick } from "svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { baseName } from "../../lib/files";
	import { awaitsHighlight, isSafeExternalUrl, renderMarkdown, renderStreaming } from "../../lib/markdown";
	import { onHighlightReady } from "../../lib/code-highlight";
	import { copyText } from "../../lib/clipboard";
	import { openExternal } from "../../lib/tauri";
	import { MediaUrls } from "../../lib/media-urls";
	import { patchHtml } from "../../lib/patch-html";
	import { closeVideoView, videoPlayer } from "../../lib/video-view";

	let { text, streaming = false, sessionId = null }: { text: string; streaming?: boolean; sessionId?: string | null } = $props();
	let root: HTMLElement | undefined = $state();

	// While streaming, re-parsing on every token is wasteful on phones; coalesce to one parse per frame.
	let shown = $state("");
	let frame = 0;
	$effect(() => {
		const next = text;
		if (!streaming) {
			cancelAnimationFrame(frame);
			shown = next;
			return;
		}
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => (shown = next));
		return () => cancelAnimationFrame(frame);
	});

	// A code block whose grammar was still loading is drawn plain; when the grammar arrives, draw the text again in colour.
	let hlTick = $state(0);
	// While streaming, only the block being written is parsed again; the blocks above it come from the cache.
	const html = $derived((void hlTick, streaming ? renderStreaming(shown) : renderMarkdown(shown)));
	const waiting = $derived(awaitsHighlight(html));
	$effect(() => {
		if (!waiting) return;
		return onHighlightReady(() => hlTick++);
	});

	// Pictures the agent wrote into the working directory (`![](out/chart.png)`) are fetched with the token and shown inline.
	// Only once the reply has settled: while streaming, the path may still be half written.
	let media = $derived.by(() => {
		const api = app.api, id = sessionId;
		return api && id ? { api, id, urls: new MediaUrls() } : null;
	});
	$effect(() => {
		const owner = media;
		return () => owner?.urls.dispose();
	});
	/** the video players this message drew: a player left on the whole screen goes away with the message */
	const videos: HTMLDivElement[] = [];
	$effect(() => {
		// read `html` for real: a bare `html;` is not a dependency, so the pictures were looked for only before the text was in the DOM
		const rendered = html;
		const host = root;
		const owner = media;
		if (!rendered || !host || !owner || streaming) return;
		const ctl = new AbortController();
		// the new HTML is put into the page after this effect runs: look for the picture slots once it is there
		void tick().then(() => {
			if (ctl.signal.aborted) return;
			fillPictures(host, owner, ctl.signal);
		});
		return () => ctl.abort();
	});
	/** More than four pictures: the fourth cell shows how many more there are (the rest are hidden until opened). */
	function setupGalleries(host: HTMLElement) {
		for (const g of host.querySelectorAll<HTMLElement>(".gallery:not([data-ready])")) {
			g.dataset.ready = "1";
			const more = (Number(g.dataset.count) || g.children.length) - 4;
			if (more <= 0) continue;
			const badge = document.createElement("span");
			badge.className = "gallery-more";
			badge.textContent = `+${more}`;
			g.append(badge);
		}
	}
	function fillPictures(host: HTMLElement, owner: NonNullable<typeof media>, signal: AbortSignal) {
		setupGalleries(host);
		for (const slot of host.querySelectorAll<HTMLElement>("span.wd-media[data-wd-src], span.wd-img[data-wd-src]")) {
			const path = slot.dataset.wdSrc!;
			const kind = slot.classList.contains("wd-img") ? "image" : slot.dataset.kind === "audio" ? "audio" : "video";
			void owner.urls.get(path, async (lifetime) => {
				const blob = await owner.api.fetchFile(owner.id, path, lifetime);
				if (blob.type.startsWith(`${kind}/`)) return blob;
				if (kind === "image") throw new Error("Not an image");
				// Some servers return application/octet-stream; players need a media type to pick a decoder.
				return new Blob([blob], { type: kind === "video" ? "video/mp4" : "audio/mpeg" });
			}).then((src) => {
				if (signal.aborted || !slot.isConnected) return;
				if (kind === "video") {
					const player = videoPlayer(src);
					videos.push(player);
					slot.replaceWith(player);
				} else if (kind === "audio") {
					const audio = document.createElement("audio");
					audio.src = src;
					audio.controls = true;
					audio.preload = "metadata";
					audio.className = "wd-audio";
					slot.replaceWith(audio);
				} else {
					const img = document.createElement("img");
					img.alt = slot.dataset.alt ?? "";
					img.src = src;
					img.className = "wd-pic";
					slot.replaceWith(img);
				}
			}).catch(() => { if (!signal.aborted) slot.classList.add("missing"); });
		}
	}
	onDestroy(() => {
		for (const player of videos) closeVideoView(player);
		videos.length = 0;
	});

	function onClick(e: MouseEvent) {
		const el = e.target as HTMLElement;
		const file = el.closest<HTMLAnchorElement>("a[data-file]");
		if (file) {
			e.preventDefault();
			if (sessionId) app.openFile(sessionId, { path: file.dataset.file!, name: baseName(file.dataset.file!) });
			return;
		}
		const copy = el.closest<HTMLButtonElement>("[data-copy]");
		if (copy) {
			const code = copy.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
			void copyText(code).then((ok) => {
				copy.textContent = ok ? t("복사됨") : t("실패");
				setTimeout(() => (copy.textContent = t("복사")), 1400);
			});
			return;
		}
		const pic = el.closest<HTMLImageElement>("img.wd-pic");
		if (pic && root) {
			// every picture of this message in one viewer, opened at the one pressed
			const all = [...root.querySelectorAll<HTMLImageElement>("img.wd-pic")];
			app.openImage(all.map((p) => ({ src: p.src, mimeType: "image/*" })), Math.max(0, all.indexOf(pic)));
			return;
		}
		const remote = el.closest<HTMLButtonElement>("button[data-img-src]");
		if (remote) {
			// Explicit consent: only now is the remote image requested.
			const img = document.createElement("img");
			img.referrerPolicy = "no-referrer";
			img.alt = remote.dataset.alt ?? "";
			img.src = remote.dataset.imgSrc ?? "";
			remote.replaceWith(img);
			return;
		}
		const a = el.closest<HTMLAnchorElement>("a[data-ext]");
		if (a) {
			e.preventDefault();
			if (isSafeExternalUrl(a.href)) void openExternal(a.href);
		}
	}
</script>

<!-- Delegated click for the links and buttons inside the rendered HTML: those are focusable and keyboard-activated themselves. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" class:streaming bind:this={root} onclick={onClick} use:patchHtml={html}></div>

<style>
	/* Korean wraps between words like the rest of the app (app.css keep-all); only a word wider than the line breaks */
	.md {
		overflow-wrap: anywhere;
	}
	.md :global(> :first-child) {
		margin-top: 0;
	}
	.md :global(> :last-child) {
		margin-bottom: 0;
	}
	.md :global(a) {
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
		transition: text-decoration-color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.md :global(a:hover) {
			text-decoration-color: var(--text);
		}
	}
	/* Block rhythm in px on the 4px scale: 12 between blocks, a heading 24 above / 8 below (em values gave 12.75 / 14.25 / 23.8 / 9.1). */
	.md :global(p) {
		margin: 0 0 12px;
	}
	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: 24px 0 8px;
		line-height: 1.3;
		font-weight: 650;
	}
	.md :global(h1) {
		font-size: 1.4em;
	}
	.md :global(h2) {
		font-size: 1.22em;
	}
	.md :global(h3) {
		font-size: 1.08em;
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 0 0 12px;
		padding-left: 24px;
	}
	.md :global(li) {
		margin: 4px 0;
	}
	.md :global(li > p) {
		margin: 4px 0;
	}
	.md :global(blockquote) {
		margin: 0 0 12px;
		padding: 0.1em 0 0.1em 16px; /* text-relative: the bar reaches just past the quoted lines */
		border-left: 3px solid var(--border-strong);
		color: var(--text-dim);
	}
	.md :global(hr) {
		border: 0;
		border-top: 1px solid var(--border);
		margin: 24px 0;
	}
	.md :global(:not(pre) > code) {
		font-family: var(--mono);
		font-size: 0.88em;
		padding: 0.15em 0.4em; /* inline code: sized with the surrounding text (a heading's code grows with it) */
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		border: 1px solid var(--border);
	}
	.md :global(.codeblock) {
		margin: 0 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-code);
		overflow: hidden;
	}
	.md :global(.codehead) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 4px 4px 12px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		border-bottom: 1px solid var(--border);
		font-family: var(--mono);
	}
	.md :global(.copy) {
		font-family: var(--font);
		font-size: var(--fs-xs);
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	@media (hover: hover) {
		.md :global(.copy:hover) {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.md :global(pre) {
		margin: 0;
		padding: 12px 12px;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		line-height: 1.55;
		tab-size: 2;
	}
	.md :global(pre code) {
		font-family: inherit;
		white-space: pre;
	}
	/* syntax colours (code-highlight.ts): colour only, never weight or size, so a block keeps its layout when it is coloured in */
	.md :global(:is(.hljs-keyword, .hljs-doctag, .hljs-template-tag, .hljs-template-variable, .hljs-type, .hljs-variable.language_, .hljs-meta .hljs-keyword)) {
		color: var(--syn-keyword);
	}
	.md :global(:is(.hljs-title, .hljs-title.class_, .hljs-title.function_)) {
		color: var(--syn-title);
	}
	.md :global(:is(.hljs-attr, .hljs-attribute, .hljs-literal, .hljs-meta, .hljs-number, .hljs-operator, .hljs-variable, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-section)) {
		color: var(--syn-number);
	}
	.md :global(:is(.hljs-string, .hljs-regexp, .hljs-meta .hljs-string)) {
		color: var(--syn-string);
	}
	.md :global(:is(.hljs-built_in, .hljs-symbol)) {
		color: var(--syn-builtin);
	}
	.md :global(:is(.hljs-comment, .hljs-code, .hljs-formula)) {
		color: var(--syn-comment);
	}
	.md :global(:is(.hljs-name, .hljs-quote, .hljs-selector-tag, .hljs-selector-pseudo, .hljs-addition)) {
		color: var(--syn-name);
	}
	.md :global(:is(.hljs-bullet, .hljs-link)) {
		color: var(--syn-bullet);
	}
	.md :global(.hljs-deletion) {
		color: var(--syn-keyword);
	}
	.md :global(.tablewrap) {
		overflow-x: auto;
		margin: 0 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.md :global(table) {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.93em;
	}
	.md :global(th),
	.md :global(td) {
		padding: 8px 12px;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	.md :global(tr:last-child td) {
		border-bottom: 0;
	}
	.md :global(th) {
		background: var(--bg-elev);
		font-weight: 600;
	}
	.md :global(img) {
		max-width: 100%;
		border-radius: var(--radius);
	}
	.md :global(a.wd-file) {
		display: inline-flex;
		align-items: center;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		text-decoration: none;
		font-size: 0.93em;
	}
	.md :global(a.wd-file::before) {
		content: "📄";
		margin-right: 4px;
		font-size: 0.9em;
	}
	@media (hover: hover) {
		.md :global(a.wd-file:hover) {
			border-color: var(--border-strong);
		}
	}
	.md :global(.wd-media) {
		color: var(--text-faint);
		font-size: var(--fs-xs);
	}
	/* the video player (lib/video-view.ts) is styled in app.css; a message only gives it room */
	.md :global(.wd-video-wrap) {
		margin: 0 0 12px;
	}
	.md :global(.wd-audio) {
		display: block;
		width: 100%;
		max-width: 420px;
		margin: 0 0 12px;
	}
	.md :global(.wd-img) {
		color: var(--text-faint);
		font-size: var(--fs-xs);
	}
	.md :global(.wd-pic) {
		display: block;
		max-height: 420px;
		cursor: zoom-in;
	}
	/* several pictures at a glance, like a social-media post: 2 side by side, 3 = one big + two, 4+ = 2x2 with "+N" */
	.md :global(.gallery) {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
		gap: 4px;
		height: 340px; /* fixed so the grid does not jump while the pictures load */
		margin: 0 0 12px;
		overflow: hidden;
		border-radius: var(--radius);
	}
	.md :global(.gallery[data-count="2"]) {
		grid-template-rows: 1fr;
		height: 260px;
	}
	.md :global(.gallery[data-count="3"] > :first-child) {
		grid-row: 1 / 3;
	}
	.md :global(.gallery > :nth-child(n + 5):not(.gallery-more)) {
		display: none;
	}
	.md :global(.gallery > .wd-img),
	.md :global(.gallery > .wd-pic) {
		display: grid;
		place-items: center;
		min-width: 0;
		min-height: 0;
		width: 100%;
		height: 100%;
		max-height: none;
		background: var(--bg-elev);
		border-radius: 0;
		object-fit: cover;
	}
	.md :global(.gallery > .gallery-more) {
		position: absolute;
		right: 0;
		bottom: 0;
		width: calc(50% - 1.5px);
		height: calc(50% - 1.5px);
		display: grid;
		place-items: center;
		color: #fff;
		font-size: 1.6em;
		font-weight: 600;
		background: rgba(0, 0, 0, 0.5);
		pointer-events: none;
	}
	.md :global(.remote-img) {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 8px;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-dim);
		font: inherit;
		font-size: var(--fs-xs);
		cursor: pointer;
	}
	@media (hover: hover) {
		.md :global(.remote-img:hover) {
			color: var(--text);
			border-color: var(--text-dim);
		}
	}

	/* Blinking caret at the very end of the text while the model is still writing. It has to sit inline in the last text
	   block: on a list (`ul`/`ol`) as a direct `::after` it became a block of its own under the list, one line taller, and
	   vanished when the next paragraph started (the whole reply jumped by a line). Down to three list levels; the caret is
	   left out where the last thing is a code block or table. Blinking only toggles visibility, so it never moves layout. */
	.md.streaming :global(> :is(p, h1, h2, h3, h4):last-child)::after,
	.md.streaming :global(> blockquote:last-child > p:last-child)::after,
	.md.streaming :global(> :is(ul, ol):last-child > li:last-child:not(:has(> :is(ul, ol, p, pre, table, blockquote, .codeblock, .tablewrap))))::after,
	.md.streaming :global(> :is(ul, ol):last-child > li:last-child > p:last-child)::after,
	.md.streaming :global(> :is(ul, ol):last-child > li:last-child > :is(ul, ol):last-child > li:last-child:not(:has(> :is(ul, ol, p, pre, table, blockquote, .codeblock, .tablewrap))))::after,
	.md.streaming :global(> :is(ul, ol):last-child > li:last-child > :is(ul, ol):last-child > li:last-child > p:last-child)::after,
	.md.streaming :global(> :is(ul, ol):last-child > li:last-child > :is(ul, ol):last-child > li:last-child > :is(ul, ol):last-child > li:last-child:not(:has(> :is(ul, ol, p, pre, table, blockquote, .codeblock, .tablewrap))))::after,
	.md.streaming :global(> :is(ul, ol):last-child > li:last-child > :is(ul, ol):last-child > li:last-child > :is(ul, ol):last-child > li:last-child > p:last-child)::after {
		content: "";
		display: inline-block;
		width: 7px;
		height: 1.05em;
		margin-left: 4px;
		vertical-align: text-bottom;
		border-radius: 2px;
		background: var(--accent);
		animation: caret 1s steps(2, start) infinite;
	}
	/* `text-wrap: balance` (app.css) re-splits a heading's lines on every token, so its words jump between lines while it is written */
	.md.streaming :global(> :last-child:is(h1, h2, h3, h4)) {
		text-wrap: wrap;
	}
	@keyframes caret {
		to {
			visibility: hidden;
		}
	}
</style>
