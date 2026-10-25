<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { capsOf } from "../lib/model-caps";

	/**
	 * What a model can do, as small icon + word tags: chat, reasoning, reading pictures, making/editing pictures.
	 * They flow one after another with an even gap: the context size first (when `ctx` is given), then the abilities.
	 * The parent decides where the run sits (left under a name, or flush right in a list row).
	 */
	let { model, ctx }: { model: { reasoning: boolean; vision: boolean; imageGeneration?: boolean }; ctx?: string } = $props();
	const caps = $derived(capsOf(model));
</script>

<span class="caps">
	{#if ctx}<span class="ctx">{ctx}</span>{/if}
	{#each caps as c (c.key)}
		<span class="cap {c.key}" title={`${t(c.label)}: ${t(c.hint)}`}><Icon name={c.icon} /><span class="word">{t(c.label)}</span></span>
	{/each}
</span>

<style>
	.caps {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px 12px;
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		white-space: nowrap;
	}
	.ctx {
		font-family: var(--mono);
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.cap :global(svg) {
		width: 13px;
		height: 13px;
		stroke: currentColor;
		stroke-width: 1.9;
		flex: none;
	}
	/* making pictures is the one ability that changes what the model is for, so it stands out */
	.image {
		color: var(--text-dim);
		font-weight: 600;
	}
</style>
