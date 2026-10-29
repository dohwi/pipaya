<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { capsOf } from "../lib/model-caps";

	/**
	 * What a model can do, as small icon + word tags: chat, reasoning, reading pictures, making/editing pictures.
	 * They flow one after another with an even gap: the context size first (when `ctx` is given), then the abilities.
	 * `end`: for a list row whose tags sit flush right. The abilities come first and the context size last, in a
	 * column of its own, so every row ends on the same line and an image model (no context) just leaves it empty.
	 * In `end` mode the tags are a four-column grid (chat | reasoning | reads images | context), so each ability sits in
	 * the same column in every row; a model without one leaves that cell empty.
	 */
	let { model, ctx, end = false }: { model: { reasoning: boolean; vision: boolean; imageGeneration?: boolean }; ctx?: string; end?: boolean } = $props();
	const caps = $derived(capsOf(model));
</script>

<span class="caps" class:end class:pics={model.imageGeneration}>
	{#if !end && !model.imageGeneration}<span class="ctx slot" class:none={!ctx} title={ctx ? t("컨텍스트 크기") : undefined}>{ctx ?? "—"}</span>{/if}
	{#each caps as c (c.key)}
		<span class="cap {c.key}" title={`${t(c.label)}: ${t(c.hint)}`}><Icon name={c.icon} /><span class="word">{t(c.label)}</span></span>
	{/each}
	{#if end && !model.imageGeneration}<span class="ctx slot" class:none={!ctx} title={ctx ? t("컨텍스트 크기") : undefined}>{ctx ?? "—"}</span>{/if}
</span>

<style>
	.caps {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 12px;
		color: var(--text-faint);
		font-size: var(--fs-2xs);
		white-space: nowrap;
	}
	/* flush-right rows: fixed columns instead of a free flow, so an ability keeps its x from row to row. 44 + 44 + 76 fits the
	   longest Korean words (채팅, 추론, 이미지 읽기) with their icons; 36 is the context column below. */
	.caps.end {
		display: grid;
		grid-template-columns: 44px 44px 76px 36px;
		column-gap: 12px;
		justify-content: end;
	}
	.caps.end .cap.chat {
		grid-column: 1;
	}
	.caps.end .cap.reasoning {
		grid-column: 2;
	}
	.caps.end .cap.vision {
		grid-column: 3;
	}
	.caps.end .ctx {
		grid-column: 4;
	}
	/* a picture model has no chat or reasoning: its tag takes the first two cells, "reads images" keeps its own */
	.caps.end.pics .cap.image {
		grid-column: 1 / span 2;
	}
	/* the context size is plain text like the abilities, only in the mono face so the digits line up */
	.ctx {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}
	/* a fixed-width column (first under a name, last in a flush-right row), so the abilities line up from row to row */
	.ctx.slot {
		min-width: 36px;
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
