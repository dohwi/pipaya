<script lang="ts">
	import { t } from "../lib/i18n";
	import { isPhone } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { compact } from "../lib/format";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import type { CatalogModel } from "../lib/types";

	/**
	 * Picks the OpenRouter model an upstream model corresponds to (used for its limits and reasoning strengths), or
	 * "manual" when there is none. Looks and behaves like ModelPickerModal: highlight, then "선택".
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

	const phone = isPhone();
	const LIMIT = 150;
	let filter = $state("");
	// svelte-ignore state_referenced_locally
	let sel = $state<string | null>(value);

	const q = $derived(filter.trim().toLowerCase());
	const hits = $derived(catalog.filter((c) => c.id !== suggested?.id && (!q || `${c.name} ${c.id}`.toLowerCase().includes(q))));
	const list = $derived(hits.slice(0, LIMIT));
	const showSuggested = $derived(!!suggested && (!q || `${suggested.name} ${suggested.id}`.toLowerCase().includes(q)));

	function confirm() {
		onpick(sel ? (catalog.find((c) => c.id === sel) ?? null) : null);
	}
	function focusFirst(node: HTMLElement) {
		if (!phone) node.focus();
	}
	const meta = (c: CatalogModel) => [`${compact(c.contextWindow)}`, c.reasoning ? t("추론") : "", c.vision ? t("이미지") : ""].filter(Boolean).join(" · ");
</script>

{#snippet opt(c: CatalogModel, recommended: boolean)}
	<div class="orow" class:sel={sel === c.id}>
		<button type="button" class="opt" aria-pressed={sel === c.id} ondblclick={() => { sel = c.id; confirm(); }} onclick={() => (sel = c.id)}>
			<span class="o-main">
				<span class="o-name">{c.name.replace(/^[^:]+:\s*/, "")}{#if recommended} <span class="rec">{t("추천")}</span>{/if}</span>
				<span class="o-meta"><span class="mono">{c.id}</span> · {meta(c)}</span>
			</span>
			{#if sel === c.id}<Icon name="check" />{/if}
		</button>
	</div>
{/snippet}

<Modal {onclose} label={t("OpenRouter 매칭 모델")} width="440px" layer={4} elevated portal>
	<div class="head" use:sheetPull={{ onclose }}>
		<div class="head-row">
			<h2>{t("OpenRouter 매칭 모델")}</h2>
			<button type="button" class="close" onclick={onclose} aria-label={t("닫기")}><Icon name="x" /></button>
		</div>
	</div>
	<div class="body">
		<input class="field search" placeholder={t("모델 검색")} bind:value={filter} aria-label={t("모델 검색")} use:focusFirst />
		<div class="list">
			<div class="orow" class:sel={sel === null}>
				<button type="button" class="opt" aria-pressed={sel === null} onclick={() => (sel = null)}>
					<span class="o-main">
						<span class="o-name">{t("수동 입력")}</span>
						<span class="o-meta">{t("매칭 없이 한도와 기능을 직접 정합니다")}</span>
					</span>
					{#if sel === null}<Icon name="check" />{/if}
				</button>
			</div>
			{#if showSuggested && suggested}
				<div class="gname">{t("추천")}</div>
				{@render opt(suggested, true)}
			{/if}
			{#if list.length}
				<div class="gname">OpenRouter</div>
				{#each list as c (c.id)}{@render opt(c, false)}{/each}
				{#if hits.length > LIMIT}<div class="empty">{t("검색어를 더 입력해 좁혀 보세요 ({n}개 더 있음)", { n: hits.length - LIMIT })}</div>{/if}
			{:else if !showSuggested}
				<div class="empty">{t("일치하는 모델이 없습니다")}</div>
			{/if}
		</div>
	</div>
	<footer>
		<span class="grow"></span>
		<button type="button" class="btn sm" onclick={onclose}>{t("취소")}</button>
		<button type="button" class="btn primary sm" onclick={confirm}>{t("선택")}</button>
	</footer>
</Modal>

<style>
	.head {
		flex: none;
	}
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 8px 4px 18px;
	}
	h2 {
		margin: 0;
		font-size: var(--fs-lg);
		font-weight: 600;
	}
	.close {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--radius);
		color: var(--text-dim);
	}
	.close :global(svg) {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 6px 14px 12px;
	}
	.search {
		flex: none;
		height: 38px;
	}
	.list {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 200px;
		overflow-y: auto;
		margin: 0 -6px;
		padding: 0 6px;
	}
	.gname {
		padding: 8px 8px 4px;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: lowercase;
		color: var(--text-faint);
	}
	.orow {
		display: flex;
		align-items: center;
		border-radius: var(--radius);
	}
	.orow:hover:not(.sel) {
		background: var(--bg-hover);
	}
	.orow.sel {
		background: var(--bg-active);
	}
	.opt {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		min-height: 44px;
		border-radius: var(--radius);
		text-align: left;
	}
	.opt :global(svg) {
		width: 17px;
		height: 17px;
		flex: none;
		stroke: var(--text);
		fill: none;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.o-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.o-name {
		font-size: var(--fs-md);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.o-meta {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rec {
		font-size: var(--fs-2xs);
		color: var(--ok);
	}
	.empty {
		padding: 16px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	footer {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px calc(10px + var(--sab));
		border-top: 1px solid var(--border);
	}
	.grow {
		flex: 1;
	}
	@media (max-width: 640px) {
		.search {
			font-size: var(--fs-lg);
		}
	}
</style>
