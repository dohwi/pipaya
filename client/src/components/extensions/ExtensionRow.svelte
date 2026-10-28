<script lang="ts">
	import type { Snippet } from "svelte";
	import { t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";

	/**
	 * One extension in the list: a card whose open button shows its name, a small state line and a short description,
	 * with the on/off switch (or nothing) at the right. Warnings about it hang under the line.
	 *
	 *  id       DOM id of the card, so closing the detail page can bring focus back to it
	 *  meta     the small line next to the name
	 *  brief    one line under the name
	 *  busy     a task is running on it
	 *  dim      it cannot work right now (a missing half): the name and text fade, the notices stay full strength
	 */
	let {
		id,
		name,
		meta,
		brief,
		busy = false,
		dim = false,
		onopen,
		control,
		notices,
	}: {
		id?: string;
		name: string;
		meta?: Snippet;
		brief?: string;
		busy?: boolean;
		/** The extension cannot work right now: the card reads as inactive. */
		dim?: boolean;
		onopen: () => void;
		control?: Snippet;
		notices?: Snippet;
	} = $props();
</script>

<!-- tabindex="-1": only so a link from elsewhere can focus this card by id; it is not in the Tab order. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article class="card" class:dim {id} tabindex={id ? -1 : undefined} aria-label={name}>
	<div class="line">
		<button type="button" class="expand" onclick={onopen}>
			<span class="who">
				<span class="top">
					<span class="ename">{name}</span>
					{#if meta}{@render meta()}{/if}
				</span>
				{#if brief}<span class="brief">{brief}</span>{/if}
			</span>
			<span class="chev"><Icon name="chevron-right" /></span>
		</button>
		{#if busy}<span class="spinner" role="status" aria-label={t("처리 중")}></span>{/if}
		{#if control}{@render control()}{/if}
	</div>
	{#if notices}{@render notices()}{/if}
</article>

<style>
	.card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); }
	.card.dim .line { opacity: 0.55; }
	.line { display: flex; align-items: center; gap: 8px; }
	.expand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 4px 4px; border-radius: var(--radius-sm); text-align: left; color: var(--text); }
	.expand:hover .ename { text-decoration: underline; text-underline-offset: 3px; }
	.expand:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.who { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; flex: 1; }
	.top { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
	.ename { font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; }
	.brief { font-size: var(--fs-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chev { flex: none; display: inline-flex; color: var(--text-faint); transition: transform var(--motion-fast) var(--ease-exit); }
	.chev :global(svg) { width: 16px; height: 16px; stroke-width: 2; }
</style>
