<script lang="ts">
	import Badge from "./Badge.svelte";
	import { t } from "../lib/i18n";
	import { compact } from "../lib/format";
	import PickerModal from "./PickerModal.svelte";
	import CapTags from "./CapTags.svelte";
	import PickerOption from "./PickerOption.svelte";
	import type { CatalogModel } from "../lib/types";

	/**
	 * Picks the OpenRouter model an upstream model corresponds to (used for its limits and reasoning strengths), or
	 * "manual" when there is none. Same shell as ModelPickerModal (PickerModal); a click picks, and the caller closes.
	 * `value`: the catalog id now in effect, or null for manual. `suggested` is shown first as the recommended match.
	 */
	let {
		catalog,
		value,
		suggested,
		onpick,
		onclose,
	}: {
		catalog: CatalogModel[];
		value: string | null;
		suggested?: CatalogModel;
		onpick: (choice: CatalogModel | null) => void;
		onclose: () => void;
	} = $props();

	const LIMIT = 150;
	let filter = $state("");

	const q = $derived(filter.trim().toLowerCase());
	const hits = $derived(catalog.filter((c) => c.id !== suggested?.id && (!q || `${c.name} ${c.id}`.toLowerCase().includes(q))));
	const rows = $derived(hits.slice(0, LIMIT));
	const showSuggested = $derived(!!suggested && (!q || `${suggested.name} ${suggested.id}`.toLowerCase().includes(q)));

</script>

{#snippet opt(c: CatalogModel, recommended: boolean)}
	<PickerOption selected={value === c.id} onclick={() => onpick(c)}>
		{#snippet name()}{c.name.replace(/^[^:]+:\s*/, "")}{#if recommended}<span class="rec"><Badge tone="ok" size="sm">{t("추천")}</Badge></span>{/if}{/snippet}
		{#snippet meta()}<span class="mono">{c.id}</span> · {#if !c.image}{compact(c.contextWindow)} · {/if}<CapTags model={{ reasoning: c.reasoning, vision: c.vision, imageGeneration: c.image }} />{/snippet}
	</PickerOption>
{/snippet}

<PickerModal title={t("OpenRouter 매칭 모델")} {onclose} bind:query={filter} placeholder={t("모델 검색")} width="440px" minList="200px">
	{#snippet list()}
		<PickerOption selected={value === null} onclick={() => onpick(null)}>
			{#snippet name()}{t("수동 입력")}{/snippet}
			{#snippet meta()}{t("매칭 없이 한도와 기능을 직접 정합니다")}{/snippet}
		</PickerOption>
		{#if showSuggested && suggested}
			<div class="pk-group">{t("추천")}</div>
			{@render opt(suggested, true)}
		{/if}
		{#if rows.length}
			<div class="pk-group">OpenRouter</div>
			{#each rows as c (c.id)}{@render opt(c, false)}{/each}
			{#if hits.length > LIMIT}<div class="pk-empty">{t("검색어를 더 입력해 좁혀 보세요 ({n}개 더 있음)", { n: hits.length - LIMIT })}</div>{/if}
		{:else if !showSuggested}
			<div class="pk-empty">{t("일치하는 모델이 없습니다")}</div>
		{/if}
	{/snippet}
</PickerModal>

<style>
	.rec {
		display: inline-flex;
		margin-left: 8px;
		vertical-align: 1px;
	}
</style>
