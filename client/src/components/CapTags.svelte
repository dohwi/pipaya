<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { capsOf } from "../lib/model-caps";

	/**
	 * What a model can do, as small icon + word tags: chat, reasoning, reading pictures, making/editing pictures.
	 * They flow one after another with an even gap: the context size first (when `ctx` is given), then the abilities.
	 * `end`: for a list row whose tags sit flush right. The abilities come first and the context size last, in a
	 * column of its own, so every row ends on the same line and an image model (no context) just leaves it empty.
	 */
	let { model, ctx, end = false }: { model: { reasoning: boolean; vision: boolean; imageGeneration?: boolean }; ctx?: string; end?: boolean } = $props();
	const caps = $derived(capsOf(model));
</script>

<span class="caps" class:end>
	{#if !end}<span class="ctx slot" class:none={!ctx} title={ctx ? t("컨텍스트 크기") : undefined}>{ctx ?? "—"}</span>{/if}
	{#each caps as c (c.key)}
		<span class="cap {c.key}" title={`${t(c.label)}: ${t(c.hint)}`}><Icon name={c.icon} /><span class="word">{t(c.label)}</span></span>
	{/each}
	{#if end}<span class="ctx slot" class:none={!ctx} title={ctx ? t("컨텍스트 크기") : undefined}>{ctx ?? "—"}</span>{/if}
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
	/* the context size is a pill of its own, so it reads as a size and not as one more ability */
	.ctx {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 18px;
		padding: 0 7px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--bg);
		color: var(--text-dim);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
	}
	/* a fixed-width column (first under a name, last in a flush-right row), so the abilities line up from row to row */
	.ctx.slot {
		min-width: 48px;
	}
	/* an image model has no context size: the column stays, with a faint dash and no pill */
	.ctx.none {
		border-color: transparent;
		background: transparent;
		color: var(--text-faint);
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
