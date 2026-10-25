<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { capsOf } from "../lib/model-caps";

	/**
	 * What a model can do, as small icon + word tags: chat, reasoning, reading pictures, making/editing pictures.
	 * Every ability has a fixed column (context size, chat, reasoning, reads images), so in a list the same ability
	 * sits on the same vertical line in every row. Making pictures takes the chat and reasoning columns.
	 * `ctx`: the context size shown in the first column; "" keeps the column empty (an image model has none).
	 */
	let { model, ctx }: { model: { reasoning: boolean; vision: boolean; imageGeneration?: boolean }; ctx?: string } = $props();
	const caps = $derived(capsOf(model));
</script>

<span class="caps">
	{#if ctx !== undefined}<span class="ctx">{ctx}</span>{/if}
	{#each caps as c (c.key)}
		<span class="cap {c.key}" title={`${t(c.label)}: ${t(c.hint)}`}><Icon name={c.icon} /><span class="word">{t(c.label)}</span></span>
	{/each}
</span>

<style>
	.caps {
		display: inline-grid;
		grid-template-columns: 4em 5.2em 5.2em 6.4em;
		align-items: center;
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		white-space: nowrap;
		column-gap: 0;
	}
	.ctx {
		grid-column: 1;
		padding-right: 1em;
		text-align: right;
		font-family: var(--mono);
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		min-width: 0;
	}
	.cap :global(svg) {
		width: 13px;
		height: 13px;
		stroke: currentColor;
		stroke-width: 1.9;
		flex: none;
	}
	.chat {
		grid-column: 2;
	}
	.reasoning {
		grid-column: 3;
	}
	.vision {
		grid-column: 4;
	}
	/* making pictures is the one ability that changes what the model is for, so it stands out */
	.image {
		grid-column: 2 / 4;
		padding-right: 0.8em;
		color: var(--text-dim);
		font-weight: 600;
	}
</style>
