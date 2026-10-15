<script lang="ts">
	import { onDestroy } from "svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { baseName } from "../lib/files";
	import { renderMarkdown, renderStreaming } from "../lib/markdown";
	import { copyText } from "../lib/clipboard";
	import { openExternal } from "../lib/tauri";

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

	// While streaming, only the block being written is parsed again; the blocks above it come from the cache.
	const html = $derived(streaming ? renderStreaming(shown) : renderMarkdown(shown));

	// Pictures the agent wrote into the working directory (`![](out/chart.png)`) are fetched with the token and shown inline.
	// Only once the reply has settled: while streaming, the path may still be half written.
	const loaded = new Map<string, string>();
	$effect(() => {
		html;
		const host = root;
		const api = app.api;
		if (!host || !api || !sessionId || streaming) return;
		const id = sessionId;
		const ctl = new AbortController();
		for (const slot of host.querySelectorAll<HTMLElement>("span.wd-img[data-wd-src]")) {
			const path = slot.dataset.wdSrc!;
			const alt = slot.dataset.alt ?? "";
			const show = (src: string) => {
				if (!slot.isConnected) return;
				const img = document.createElement("img");
				img.alt = alt;
				img.src = src;
				img.className = "wd-pic";
				img.addEventListener("click", () => app.openImage([{ src, mimeType: "image/*" }]));
				slot.replaceWith(img);
			};
			const key = `${id}\u0000${path}`;
			const hit = loaded.get(key);
			if (hit) {
				show(hit);
				continue;
			}
			api.fetchFile(id, path, ctl.signal)
				.then((blob) => {
					if (!blob.type.startsWith("image/")) return;
					const src = URL.createObjectURL(blob);
					loaded.set(key, src);
					show(src);
				})
				.catch(() => slot.classList.add("missing"));
		}
		return () => ctl.abort();
	});
	onDestroy(() => {
		for (const src of loaded.values()) URL.revokeObjectURL(src);
		loaded.clear();
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
			void openExternal(a.href);
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" class:streaming bind:this={root} onclick={onClick}>{@html html}</div>

<style>
	.md {
		overflow-wrap: anywhere;
		word-break: break-word;
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
	.md :global(a:hover) {
		text-decoration-color: var(--text);
	}
	.md :global(p) {
		margin: 0 0 0.85em;
	}
	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: 1.3em 0 0.5em;
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
		margin: 0 0 0.85em;
		padding-left: 1.5em;
	}
	.md :global(li) {
		margin: 0.2em 0;
	}
	.md :global(li > p) {
		margin: 0.2em 0;
	}
	.md :global(blockquote) {
		margin: 0 0 0.85em;
		padding: 0.1em 1em;
		border-left: 3px solid var(--border-strong);
		color: var(--text-dim);
	}
	.md :global(hr) {
		border: 0;
		border-top: 1px solid var(--border);
		margin: 1.4em 0;
	}
	.md :global(:not(pre) > code) {
		font-family: var(--mono);
		font-size: 0.88em;
		padding: 0.15em 0.4em;
		border-radius: var(--radius-sm);
		background: var(--bg-elev);
		border: 1px solid var(--border);
	}
	.md :global(.codeblock) {
		margin: 0 0 0.95em;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-code);
		overflow: hidden;
	}
	.md :global(.codehead) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 5px 6px 5px 14px;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		border-bottom: 1px solid var(--border);
		font-family: var(--mono);
	}
	.md :global(.copy) {
		font-family: var(--font);
		font-size: var(--fs-xs);
		padding: 4px 10px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
	}
	.md :global(.copy:hover) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.md :global(pre) {
		margin: 0;
		padding: 12px 14px;
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
	.md :global(.tablewrap) {
		overflow-x: auto;
		margin: 0 0 0.95em;
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
		padding: 7px 12px;
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
		margin-right: 5px;
		font-size: 0.9em;
	}
	.md :global(a.wd-file:hover) {
		border-color: var(--border-strong);
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
	.md :global(.remote-img) {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 10px;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-dim);
		font: inherit;
		font-size: var(--fs-xs);
		cursor: pointer;
	}
	.md :global(.remote-img:hover) {
		color: var(--text);
		border-color: var(--text-dim);
	}

	/* blinking caret on the last block while the model is still writing */
	.md.streaming :global(> :last-child::after) {
		content: "";
		display: inline-block;
		width: 7px;
		height: 1.05em;
		margin-left: 3px;
		vertical-align: text-bottom;
		border-radius: 2px;
		background: var(--accent);
		animation: caret 1s steps(2, start) infinite;
	}
	.md.streaming :global(> pre:last-child::after),
	.md.streaming :global(> .codeblock:last-child::after),
	.md.streaming :global(> .tablewrap:last-child::after) {
		display: none;
	}
	@keyframes caret {
		to {
			visibility: hidden;
		}
	}
</style>
