<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { capsOf } from "../lib/model-caps";

	/**
	 * What a model can do, as small icon + word tags: chat, reasoning, reading pictures, making/editing pictures.
	 * `compact` drops the words (icons only, the tooltip still says what each one is) for dense rows.
	 */
	let { model, compact = false }: { model: { reasoning: boolean; vision: boolean; imageGeneration?: boolean }; compact?: boolean } = $props();
	const caps = $derived(capsOf(model));
</script>

<span class="caps" class:compact>
	{#each caps as c (c.key)}
		<span class="cap {c.key}" title={`${t(c.label)}: ${t(c.hint)}`}><Icon name={c.icon} />{#if !compact}<span>{t(c.label)}</span>{/if}</span>
	{/each}
</span>

<style>
	.caps {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 8px;
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		white-space: nowrap;
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}
	.cap :global(svg) {
		width: 13px;
		height: 13px;
		stroke: currentColor;
		stroke-width: 1.9;
		flex: none;
	}
	/* making pictures is the one ability that changes what the model is for, so it stands out */
	.cap.image {
		color: var(--text-dim);
		font-weight: 600;
	}
</style>
