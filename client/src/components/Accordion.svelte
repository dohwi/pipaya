<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import { collapseIn, collapseOut } from "../lib/motion";

	/**
	 * A fold with an animated body. A native <details> snaps open and cannot be animated, so the header is a
	 * button (aria-expanded) and the body is mounted only while open, sliding with the same collapseIn/collapseOut
	 * as the rest of the client. The arrow turns with the same timing as the body.
	 *
	 *  - "line": a rule above the header, for sections inside a card;
	 *  - "box": its own bordered box, for a list of foldable panels;
	 *  - "text": a small inline toggle with no chrome.
	 */
	let {
		open = $bindable(false),
		variant = "line",
		head,
		children,
		onchange,
	}: {
		open?: boolean;
		variant?: "line" | "box" | "text";
		head: Snippet;
		children: Snippet;
		onchange?: (open: boolean) => void;
	} = $props();

	const uid = $props.id();
	const bodyId = `${uid}-body`;

	function toggle() {
		open = !open;
		onchange?.(open);
	}
</script>

<div class="acc {variant}" class:open>
	<button type="button" class="head" onclick={toggle} aria-expanded={open} aria-controls={bodyId}>
		<span class="label">{@render head()}</span>
		<span class="chev" class:open><Icon name="chevron-down" /></span>
	</button>
	{#if open}
		<div class="body" id={bodyId} in:collapseIn out:collapseOut>
			<div class="inner">{@render children()}</div>
		</div>
	{/if}
</div>

<style>
	.acc { min-width: 0; }
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		margin: 0;
		border: 0;
		background: none;
		font: inherit;
		text-align: left;
		color: var(--text-dim);
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	.head:hover, .open > .head { color: var(--text); }
	.head:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.label { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
	/* the arrow turns in step with the body: collapseIn (normal, ease) when opening, collapseOut (fast, ease-exit) when closing */
	.chev { flex: none; display: inline-flex; color: var(--text-faint); transition: transform var(--motion-fast) var(--ease-exit); }
	.chev.open { transform: rotate(180deg); transition: transform var(--motion-normal) var(--ease); }
	/* Icon.svelte only supplies the path; how it is painted is the caller's job. Without these the arrow is a filled black shape (invisible on a dark background). */
	.chev :global(svg) { width: 16px; height: 16px; stroke-width: 2; }

	/* the height animates on .body (sliding); the spacing lives on .inner so it grows with it and does not jump */
	/* overflow must clip for the slide, but it would also cut focus rings of fields in the body: pad it and pull the margin back */
	.body { overflow: hidden; padding: 4px; margin: -4px; }

	.line { border-top: 1px solid var(--border); }
	.line .head { padding: 10px 2px; font-size: var(--fs-sm); font-weight: 500; }
	.line .inner { padding: 0 2px 4px; }

	.box { border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); overflow: hidden; }
	.box .head { padding: 12px 14px; border-radius: 0; font-size: var(--fs-xs); font-weight: 600; }
	.box .head:hover { background: var(--bg-hover); }
	.box .inner { padding: 16px; border-top: 1px solid var(--border); }

	.text .head { width: fit-content; justify-content: flex-start; gap: 4px; font-size: var(--fs-xs); }
	.text .label { flex: none; }
	.text .inner { padding-top: 8px; }

	@media (prefers-reduced-motion: reduce) { .chev, .chev.open { transition: none; } }
</style>
