<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import { t } from "../../lib/i18n";
	import { compact } from "../../lib/format";
	import PickerModal from "../ui/PickerModal.svelte";
	import CapTags from "./CapTags.svelte";
	import PickerOption from "../ui/PickerOption.svelte";
	import type { CatalogInfo, CatalogModel } from "../../lib/types";

	/**
	 * Picks the OpenRouter model an upstream model corresponds to (used for its limits and reasoning strengths), or
	 * "manual" when there is none. Same shell as ModelPickerModal (PickerModal); a click picks, and the caller closes.
	 * `value`: the catalog id now in effect, or null for manual. `suggested` is shown first as the recommended match.
	 * `info` says how current the list is (the server fetches OpenRouter's own list and caches it), and `onrefresh`
	 * asks for a fresh one, so a model added upstream today can be picked without waiting for a release.
	 */
	let {
		catalog,
		info = null,
		refreshing = false,
		onrefresh,
		value,
		suggested,
		onpick,
		onclose,
	}: {
		catalog: CatalogModel[];
		info?: Omit<CatalogInfo, "models"> | null;
		refreshing?: boolean;
		onrefresh?: () => void;
		value: string | null;
		suggested?: CatalogModel;
		onpick: (choice: CatalogModel | null) => void;
		onclose: () => void;
	} = $props();

	/** "6시간 전": how long ago the list was fetched, so "not there" reads as "not there yet" when it is old. */
	function ago(at: number): string {
		const min = Math.floor((Date.now() - at) / 60_000);
		if (min < 1) return t("방금");
		if (min < 60) return t("{n}분 전", { n: min });
		const hour = Math.floor(min / 60);
		if (hour < 24) return t("{n}시간 전", { n: hour });
		return t("{n}일 전", { n: Math.floor(hour / 24) });
	}
	/**
	 * One short line in the footer: where the list came from and how old it is. The reason a fetch failed goes in the
	 * tooltip instead of the line, so the line never ellipsizes the part that matters.
	 */
	const source = $derived.by(() => {
		if (!info) return "";
		if (!info.live) return info.error ? t("목록을 불러오지 못했습니다") : t("서버에 포함된 목록");
		return t("OpenRouter 목록 · {ago} 갱신", { ago: ago(info.updatedAt) });
	});
	/** The tooltip: the full story, including why a fetch failed. */
	const detail = $derived.by(() => {
		if (!info) return "";
		if (!info.error) return t("OpenRouter에서 목록을 다시 받아옵니다");
		return info.live
			? t("OpenRouter 목록을 불러오지 못했습니다: {error} · {ago} 목록", { error: info.error, ago: ago(info.updatedAt) })
			: t("OpenRouter 목록을 불러오지 못했습니다: {error} · 서버에 포함된 목록", { error: info.error });
	});

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
		{#snippet meta()}<span class="mono">{c.id}</span> · <CapTags model={{ reasoning: c.reasoning, vision: c.vision, imageGeneration: c.image }} ctx={c.image ? undefined : compact(c.contextWindow)} />{/snippet}
	</PickerOption>
{/snippet}

<PickerModal title={t("OpenRouter 매칭 모델")} {onclose} bind:query={filter} placeholder={t("모델 검색")} width="440px" minList="200px">
	{#snippet footerStart()}
		{#if onrefresh}
			<button type="button" class="src" onclick={onrefresh} disabled={refreshing} title={detail}>
				<Icon name="retry" />
				<span>{refreshing ? t("불러오는 중…") : source}</span>
			</button>
		{:else}
			<span class="src plain" title={detail}>{source}</span>
		{/if}
	{/snippet}
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
	/* The footer's left side: one small line saying where the list came from, and the way to fetch a newer one. */
	.src {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		/* shrinks (and ellipsizes) instead of pushing the close button off a narrow sheet; 260px is the widest it needs */
		flex: 0 1 auto;
		min-width: 0;
		max-width: 260px;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
		text-align: left;
	}
	button.src {
		cursor: pointer;
	}
	button.src:hover:not(:disabled) {
		color: var(--text-dim);
	}
	button.src:disabled {
		cursor: default;
	}
	.src :global(svg) {
		flex: none;
		width: 14px;
		height: 14px;
	}
	.src span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rec {
		display: inline-flex;
		margin-left: 8px;
		vertical-align: 1px;
	}
</style>
