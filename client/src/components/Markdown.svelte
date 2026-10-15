<script lang="ts">
	import { t } from "../lib/i18n";
	import { renderMarkdown, renderStreaming } from "../lib/markdown";
	import { copyText } from "../lib/clipboard";
	import { openExternal } from "../lib/tauri";

	let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

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

	function onClick(e: MouseEvent) {
		const el = e.target as HTMLElement;
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
<div class="md" class:streaming onclick={onClick}>{@html html}</div>

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
