<script lang="ts">
	import { onDestroy, tick, untrack } from "svelte";
	import { getLang, t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { baseName } from "../../lib/files";
	import { awaitsHighlight, isSafeExternalUrl, renderMarkdown, renderStreaming } from "../../lib/markdown";
	import { onHighlightReady } from "../../lib/code-highlight";
	import { copyText } from "../../lib/clipboard";
	import { openExternal } from "../../lib/tauri";
	import { sharedMedia } from "../../lib/media-urls";
	import { patchHtml, type PatchInput } from "../../lib/patch-html";
	import { decorateMarkdownTokens, mentionSignature } from "../../lib/markdown-tokens";
	import { closeVideoView, videoPlayer } from "../../lib/video-view";

	const INLINE_IMAGE_MAX = 1280;

	let {
		text,
		streaming = false,
		sessionId = null,
		mentions = false,
	}: { text: string; streaming?: boolean; sessionId?: string | null; mentions?: boolean } = $props();
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

	// Assistant replies highlight known @session / @group mentions, /skill:name, /prompt:name, #path, and repo-relative
	// file paths in inline `<code>` into clickable chips, matching TokenText. `mentionSig` narrows reactivity to targets
	// that actually appear in this message so unrelated session changes never re-patch the DOM or reset loaded media.
	const mentionSig = $derived(mentions ? mentionSignature(html, app.mentionIndex) : "");
	const patchInput = $derived.by((): PatchInput => {
		const raw = html;
		if (!mentions) return raw;
		const sig = mentionSig;
		const hasSkill = raw.includes("/skill:");
		const hasPrompt = raw.includes("/prompt:");
		const hasFiles = !!sessionId && (raw.includes("<code>") || /(?:^|[\s>])#[^\s#&]/.test(raw));
		if (!sig && !hasSkill && !hasPrompt && !hasFiles) return raw;
		void getLang(); // re-apply tooltips when the UI language switches
		const index = untrack(() => app.mentionIndex);
		const labels = {
			openSession: (name: string) => t("{name} 대화 열기", { name }),
			openGroup: (name: string) => t("{name} 그룹 열기", { name }),
			openSkill: (name: string) => t("스킬 {name} 보기", { name }),
			openPrompt: (name: string) => t("프롬프트 {name} 보기", { name }),
			openFile: (name: string) => t("{name} 미리 보기", { name }),
		};
		return {
			html: raw,
			decorate: (frag) => decorateMarkdownTokens(frag, { index, skills: hasSkill, prompts: hasPrompt, files: hasFiles, labels }),
		};
	});

	// Pictures the agent wrote into the working directory (`![](out/chart.png)`) are fetched with the token and shown inline.
	// Blob URLs live in the app-wide LRU cache (`sharedMedia`) so switching tabs or remounting after a stream settles
	// displays already-fetched pictures immediately without downloading them again.
	let media = $derived.by(() => {
		const api = app.api, id = sessionId;
		return api && id ? { api, id, base: api.baseUrl } : null;
	});
	/** the video players this message drew: a player left on the whole screen goes away with the message */
	const videos: HTMLDivElement[] = [];
	$effect(() => {
		// read `patchInput` for real: a bare `html;` is not a dependency, and a mention re-patch restores cached images synchronously
		const rendered = patchInput;
		const host = root;
		const owner = media;
		const live = streaming;
		if (!rendered || !host || !owner) return;
		const ctl = new AbortController();
		// the new HTML is put into the page after this effect runs: look for the picture slots once it is there
		void tick().then(() => {
			if (ctl.signal.aborted) return;
			if (live) prefetchPictures(host, owner);
			else fillPictures(host, owner, ctl.signal);
		});
		return () => ctl.abort();
	});
	function mediaKey(owner: NonNullable<typeof media>, kind: "image" | "image-full" | "audio" | "video", path: string): string {
		return `${owner.base}\0${owner.id}\0${kind === "image" ? INLINE_IMAGE_MAX : kind}\0${path}`;
	}
	function loadSlotBlob(owner: NonNullable<typeof media>, kind: "image" | "audio" | "video", path: string): (signal: AbortSignal) => Promise<Blob> {
		return async (signal) => {
			const blob = await owner.api.fetchFile(owner.id, path, signal, kind === "image" ? { max: INLINE_IMAGE_MAX } : undefined);
			if (blob.type.startsWith(`${kind}/`)) return blob;
			if (kind === "image") throw new Error("Not an image");
			// Some servers return application/octet-stream; players need a media type to pick a decoder.
			return new Blob([blob], { type: kind === "video" ? "video/mp4" : "audio/mpeg" });
		};
	}
	function loadFullImageBlob(owner: NonNullable<typeof media>, path: string): (signal: AbortSignal) => Promise<Blob> {
		return async (signal) => {
			const blob = await owner.api.fetchFile(owner.id, path, signal);
			if (blob.type.startsWith("image/")) return blob;
			throw new Error("Not an image");
		};
	}
	/** Prefetch completed image links into `sharedMedia` while the rest of the reply still streams, without touching the DOM. */
	function prefetchPictures(host: HTMLElement, owner: NonNullable<typeof media>) {
		for (const slot of host.querySelectorAll<HTMLElement>("span.wd-img[data-wd-src]")) {
			const path = slot.dataset.wdSrc!;
			sharedMedia.prefetch(mediaKey(owner, "image", path), loadSlotBlob(owner, "image", path));
		}
	}
	function applyLoadedSlot(slot: HTMLElement, kind: "image" | "audio" | "video", src: string) {
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
			img.decoding = "async";
			img.src = src;
			img.className = "wd-pic";
			if (slot.dataset.wdSrc) img.dataset.wdSrc = slot.dataset.wdSrc;
			slot.replaceWith(img);
		}
	}
	function loadSlot(slot: HTMLElement, owner: NonNullable<typeof media>, signal?: AbortSignal) {
		const path = slot.dataset.wdSrc!;
		const kind = slot.classList.contains("wd-img") ? "image" : slot.dataset.kind === "audio" ? "audio" : "video";
		const key = mediaKey(owner, kind, path);
		const cached = sharedMedia.peek(key);
		if (cached) {
			applyLoadedSlot(slot, kind, cached);
			return;
		}
		slot.classList.remove("missing");
		slot.classList.add("loading");
		slot.removeAttribute("role");
		slot.removeAttribute("tabindex");
		slot.removeAttribute("title");
		void sharedMedia.get(key, loadSlotBlob(owner, kind, path), signal).then((src) => {
			if (signal?.aborted || !slot.isConnected) return;
			applyLoadedSlot(slot, kind, src);
		}).catch(() => {
			if (signal?.aborted || !slot.isConnected) return;
			slot.classList.remove("loading");
			slot.classList.add("missing");
			slot.setAttribute("role", "button");
			slot.setAttribute("tabindex", "0");
			slot.title = t("이미지를 불러오지 못했습니다 · 눌러서 다시 시도");
		});
	}
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
			loadSlot(slot, owner, signal);
		}
	}
	const copyTimers = new Set<ReturnType<typeof setTimeout>>();
	onDestroy(() => {
		for (const id of copyTimers) clearTimeout(id);
		copyTimers.clear();
		for (const player of videos) closeVideoView(player);
		videos.length = 0;
	});

	function onClick(e: MouseEvent) {
		const el = e.target as HTMLElement;
		if (mentions) {
			const mention = el.closest<HTMLButtonElement>("button[data-mention-id]");
			if (mention) {
				app.openMention({
					kind: mention.dataset.mentionKind === "group" ? "group" : "session",
					id: mention.dataset.mentionId!,
				});
				return;
			}
			const skill = el.closest<HTMLButtonElement>("button[data-skill]");
			if (skill) {
				const name = skill.dataset.skill ?? "";
				if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) app.openSkills(sessionId, name);
				return;
			}
			const prompt = el.closest<HTMLButtonElement>("button[data-prompt]");
			if (prompt) {
				const name = prompt.dataset.prompt ?? "";
				if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) app.openTemplates(sessionId);
				return;
			}
		}
		const file = el.closest<HTMLElement>(mentions ? "a[data-file], button[data-file]" : "a[data-file]");
		if (file) {
			e.preventDefault();
			const path = file.dataset.file;
			if (sessionId && path) {
				const line = Number(file.dataset.line);
				const endLine = Number(file.dataset.endLine);
				app.openFile(sessionId, {
					path,
					name: baseName(path),
					...(Number.isSafeInteger(line) && line >= 1 ? { line } : {}),
					...(Number.isSafeInteger(endLine) && endLine >= line ? { endLine } : {}),
				});
			}
			return;
		}
		const copy = el.closest<HTMLButtonElement>("[data-copy]");
		if (copy) {
			const code = copy.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
			void copyText(code).then((ok) => {
				copy.textContent = ok ? t("복사됨") : t("실패");
				const timer = setTimeout(() => {
					copyTimers.delete(timer);
					copy.textContent = t("복사");
				}, 1400);
				copyTimers.add(timer);
			});
			return;
		}
		const pic = el.closest<HTMLImageElement>("img.wd-pic");
		if (pic && root) {
			// every picture of this message in one viewer, opened at the one pressed; fetch full resolution on demand
			const all = [...root.querySelectorAll<HTMLImageElement>("img.wd-pic")];
			const owner = media;
			app.openImage(
				all.map((p) => {
					const path = p.dataset.wdSrc;
					if (!owner || !path) return { src: p.src, mimeType: "image/*" };
					const fullKey = mediaKey(owner, "image-full", path);
					const cachedFull = sharedMedia.peek(fullKey);
					if (cachedFull) return { src: cachedFull, mimeType: "image/*" };
					return {
						src: p.src,
						mimeType: "image/*",
						loadFull: (signal?: AbortSignal) => sharedMedia.get(fullKey, loadFullImageBlob(owner, path), signal),
					};
				}),
				Math.max(0, all.indexOf(pic)),
			);
			return;
		}
		const retry = el.closest<HTMLElement>(".wd-img.missing[data-wd-src], .wd-media.missing[data-wd-src]");
		if (retry && media) {
			loadSlot(retry, media);
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
	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== "Enter" && e.key !== " ") return;
		const retry = (e.target as HTMLElement | null)?.closest<HTMLElement>(".wd-img.missing[data-wd-src], .wd-media.missing[data-wd-src]");
		if (retry && media) {
			e.preventDefault();
			loadSlot(retry, media);
		}
	}
</script>

<!-- Delegated click for the links and buttons inside the rendered HTML: those are focusable and keyboard-activated themselves. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="md" class:streaming bind:this={root} onclick={onClick} onkeydown={onKeyDown} use:patchHtml={patchInput}></div>

<style>
	/* Korean wraps between words like the rest of the app (app.css keep-all); only a word wider than the line breaks */
	.md {
		overflow-wrap: anywhere;
		line-height: 24px; /* whole-pixel line box (vs body's 23.25px) so streaming growth keeps scroll heights integer */
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
		border-radius: var(--radius-xs);
		background: var(--bg-elev);
		border: 1px solid var(--border);
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
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
		padding: 12px;
		overflow-x: auto;
		overflow-y: hidden;
		-webkit-overflow-scrolling: touch;
		font-family: var(--mono);
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel line box (vs 20.15px at 1.55) so streaming code blocks keep scroll heights integer */
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
		overflow-y: hidden;
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
	/* Matches TokenText's `.tok.file` chip: monochrome file glyph, atomic inline-flex, directory shrinks before basename. */
	.md :global(:is(a, button).wd-file) {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 1px 0.4em; /* em sides scale with the text, like inline code and TokenText */
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--mark-file) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mark-file) 22%, transparent);
		color: inherit;
		font: inherit;
		text-decoration: none;
		font-size: 0.88em;
		line-height: 18px; /* whole-pixel 20px box (18 + 2 padding), matching TokenText */
		vertical-align: -1px; /* measured: aligns chip ink with surrounding 24px body text (<= 0.5px) */
		cursor: pointer;
		transition: none; /* instant hover tint avoids GPU background-color layer promotion snapping inline chips by 1px */
	}
	.md :global(:is(a, button).wd-file::before) {
		content: "";
		flex: none;
		width: 12px;
		height: 12px;
		background: currentColor;
		opacity: 0.7;
		-webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 3h7l5 5v13H7zM14 3v5h5'/%3E%3C/svg%3E") center / contain no-repeat;
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 3h7l5 5v13H7zM14 3v5h5'/%3E%3C/svg%3E") center / contain no-repeat;
	}
	.md :global(:is(a, button).wd-file .wd-lbl) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.md :global(:is(a, button).wd-file .wd-path) {
		display: inline-flex;
		min-width: 0;
	}
	.md :global(:is(a, button).wd-file .wd-dir) {
		flex: 0 999999 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.68;
	}
	.md :global(:is(a, button).wd-file .wd-base) {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.md :global(a.wd-file code) {
		padding: 0;
		border: 0;
		background: none;
		font-size: inherit;
		line-height: inherit;
	}
	@media (hover: hover) {
		.md :global(:is(a, button).wd-file:hover) {
			background: color-mix(in srgb, var(--mark-file) 22%, transparent);
		}
	}
	/* Matches TokenText's `.tok.mention` and `.tok.skill` chips: amber @session / @group and accent /skill: & /prompt: marks. */
	.md :global(button.wd-mention),
	.md :global(button.wd-skill),
	.md :global(button.wd-prompt) {
		--hue: var(--mark-mention);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 1px 0.4em; /* em sides scale with the text, like inline code and TokenText */
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--hue) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 22%, transparent);
		color: inherit;
		font: inherit;
		font-size: 0.88em;
		font-weight: 600;
		line-height: 18px; /* whole-pixel 20px box (18 + 2 padding), matching TokenText */
		vertical-align: -1px; /* measured: aligns chip ink with surrounding 24px body text (<= 0.5px) */
		cursor: pointer;
		transition: none; /* instant hover tint avoids GPU background-color layer promotion snapping inline chips by 1px */
	}
	.md :global(button.wd-mention) {
		color: var(--hue);
	}
	.md :global(button.wd-skill),
	.md :global(button.wd-prompt) {
		--hue: var(--accent);
	}
	.md :global(button.wd-skill::before),
	.md :global(button.wd-prompt::before) {
		content: "";
		flex: none;
		width: 12px;
		height: 12px;
		background: currentColor;
		opacity: 0.7;
	}
	.md :global(button.wd-skill::before) {
		-webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 7c-1.6-1.4-3.7-2-7-2v13c3.3 0 5.4.6 7 2 1.6-1.4 3.7-2 7-2V5c-3.3 0-5.4.6-7 2zM12 7v13'/%3E%3C/svg%3E") center / contain no-repeat;
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 7c-1.6-1.4-3.7-2-7-2v13c3.3 0 5.4.6 7 2 1.6-1.4 3.7-2 7-2V5c-3.3 0-5.4.6-7 2zM12 7v13'/%3E%3C/svg%3E") center / contain no-repeat;
	}
	.md :global(button.wd-prompt::before) {
		-webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 8l5 4-5 4M12 17h7'/%3E%3C/svg%3E") center / contain no-repeat;
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 8l5 4-5 4M12 17h7'/%3E%3C/svg%3E") center / contain no-repeat;
	}
	.md :global(button.wd-mention .wd-lbl),
	.md :global(button.wd-skill .wd-lbl),
	.md :global(button.wd-prompt .wd-lbl) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (hover: hover) {
		.md :global(button.wd-mention:hover),
		.md :global(button.wd-skill:hover),
		.md :global(button.wd-prompt:hover) {
			background: color-mix(in srgb, var(--hue) 22%, transparent);
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
		line-height: 20px;
	}
	.md :global(.wd-img.loading),
	.md :global(.wd-media.loading) {
		animation: wd-pulse 1.4s ease-in-out infinite;
	}
	.md :global(.wd-img.missing),
	.md :global(.wd-media.missing) {
		color: var(--text-dim);
		text-decoration: underline;
		text-decoration-style: dashed;
		cursor: pointer;
	}
	@keyframes wd-pulse {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.md :global(.wd-img.loading),
		.md :global(.wd-media.loading) {
			animation: none;
		}
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
		display: inline-block;
		max-width: 100%;
		height: 28px;
		line-height: 26px; /* 26 + 2 border = 28px single-line pill */
		padding: 0 8px;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-dim);
		font: inherit;
		font-size: var(--fs-xs);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: middle;
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
