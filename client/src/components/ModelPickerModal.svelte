<script lang="ts">
	import { t } from "../lib/i18n";
	import { isPhone } from "../lib/motion";
	import { sheetPull } from "../lib/sheet";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { compact } from "../lib/format";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import ModelLogo from "./ModelLogo.svelte";
	import type { ModelInfo, ProviderInfo, ThinkingLevel } from "../lib/types";

	/**
	 * The one place a model is chosen. A model and its reasoning strength are a pair: the list picks the model, the
	 * strength row sits right under it, and `onpick` always reports both. Every setting that selects a model (the
	 * composer, the new-chat default, compaction, the sub-agent) opens this same dialog.
	 *
	 * It holds no knowledge of which server or chat it is for: the caller passes the models in and gets the pair back.
	 * `level` is the strength to show (null = not chosen yet, the row is shown with nothing selected).
	 * `allowUnset` adds a first row that reports `null` ("use the default"), with `unsetLabel` as its text.
	 */
	let {
		models,
		providers = [],
		value,
		level = null,
		favs = [],
		allowUnset = false,
		unsetLabel,
		title,
		onpick,
		onfav,
		onmanage,
		onclose,
	}: {
		models: ModelInfo[];
		providers?: ProviderInfo[];
		value: { provider: string; model: string } | null;
		level?: ThinkingLevel | null;
		favs?: string[];
		allowUnset?: boolean;
		unsetLabel?: string;
		title?: string;
		onpick: (choice: { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null) => void;
		/** Star a model; omit to hide the stars */
		onfav?: (provider: string, id: string) => void;
		onmanage?: () => void;
		onclose: () => void;
	} = $props();

	const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
	const phone = isPhone();

	let filter = $state("");
	/** What is highlighted now. Every click is applied at once through `onpick`; the dialog stays open. */
	// svelte-ignore state_referenced_locally
	let sel = $state<{ provider: string; model: string } | null>(value);
	// svelte-ignore state_referenced_locally
	let lvl = $state<ThinkingLevel | null>(level);

	const key = (p: string, id: string) => `${p}\u0000${id}`;
	const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
	const isFav = (m: ModelInfo) => favs.includes(key(m.provider, m.id));
	const matches = (m: ModelInfo) => !filter || `${providerName(m.provider)} ${m.name} ${m.id}`.toLowerCase().includes(filter.toLowerCase());
	const info = $derived(sel ? models.find((m) => m.provider === sel!.provider && m.id === sel!.model) : undefined);
	const reasoning = $derived(info ? info.reasoning : true);
	/** Only the strengths this model accepts (older servers do not say: then all of them). */
	const available = $derived<ThinkingLevel[]>(info?.thinkingLevels?.length ? levels.filter((l) => info.thinkingLevels!.includes(l)) : levels);
	/** The highlighted strength, moved to the nearest supported one when the model does not accept it. */
	const shownLvl = $derived.by<ThinkingLevel | null>(() => {
		if (!lvl || available.includes(lvl)) return lvl;
		const i = levels.indexOf(lvl);
		return available.find((l) => levels.indexOf(l) >= i) ?? available[available.length - 1] ?? null;
	});

	const groups = $derived.by(() => {
		const by = new Map<string, ModelInfo[]>();
		for (const m of models) {
			if (!by.has(m.provider)) by.set(m.provider, []);
			by.get(m.provider)!.push(m);
		}
		return [...by.entries()]
			.map(([id, list]) => ({ id, name: providerName(id), configured: list.some((m) => m.configured), models: list }))
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	});
	const shown = $derived(groups.map((g) => ({ ...g, models: g.models.filter((m) => !isFav(m) && matches(m)) })).filter((g) => g.models.length));
	const starred = $derived(favs.map((k) => models.find((m) => key(m.provider, m.id) === k)).filter((m): m is ModelInfo => !!m && matches(m)));

	const same = (m: ModelInfo) => !!sel && sel.provider === m.provider && sel.model === m.id;
	function choose(m: ModelInfo) {
		if (!m.configured) return;
		sel = { provider: m.provider, model: m.id };
	}
	function confirm() {
		if (!sel) return onpick(null);
		onpick({ provider: sel.provider, model: sel.model, ...(shownLvl && reasoning ? { thinkingLevel: shownLvl } : {}) });
	}

	function focusFirst(node: HTMLElement) {
		if (!phone) node.focus();
	}
</script>

{#snippet opt(m: ModelInfo, inFavs: boolean)}
	{@const fav = isFav(m)}
	<div class="orow" class:sel={same(m)}>
		<button type="button" class="opt" class:dim={!m.configured} aria-pressed={same(m)} aria-disabled={!m.configured} ondblclick={() => { choose(m); confirm(); }} onclick={() => choose(m)}>
			<span class="o-main">
				<span class="o-name">{m.name}</span>
				<span class="o-meta">
					{#if inFavs}{providerName(m.provider)} · {/if}{t("컨텍스트")} {compact(m.contextWindow)}{#if m.reasoning} · {t("추론")}{/if}{#if m.vision} · {t("이미지")}{/if}{#if !m.configured} · {t("키 없음")}{/if}
				</span>
			</span>
			{#if same(m)}<Icon name="check" />{/if}
		</button>
		{#if onfav}
			<button type="button" class="fav" class:on={fav} onclick={() => onfav(m.provider, m.id)} aria-pressed={fav} aria-label={t("{name} 즐겨찾기", { name: m.name })} title={fav ? t("즐겨찾기 해제") : t("즐겨찾기")}>
				<Icon name="star" />
			</button>
		{/if}
	</div>
{/snippet}

<!-- opened from the composer (over the page) or from settings: the top layer works for both -->
<Modal {onclose} label={title ?? t("모델 설정")} width="m" layer={4} elevated portal>
	<div class="head" use:sheetPull={{ onclose }}>
		<div class="head-row">
			<h2>{title ?? t("모델 설정")}</h2>
			<button type="button" class="close" onclick={onclose} aria-label={t("닫기")}><Icon name="x" /></button>
		</div>
	</div>

	<div class="body">
		<input class="field search" placeholder={t("모델 검색")} bind:value={filter} aria-label={t("모델 검색")} use:focusFirst />
		<div class="list">
			{#if allowUnset}
				<div class="orow" class:sel={!sel}>
					<button type="button" class="opt" aria-pressed={!sel} onclick={() => (sel = null)}>
						<span class="o-main"><span class="o-name">{unsetLabel ?? t("지정 안 함")}</span></span>
						{#if !sel}<Icon name="check" />{/if}
					</button>
				</div>
			{/if}
			{#if starred.length}
				<div class="gname"><span class="gstar"><Icon name="star" /></span>{t("즐겨찾기")}</div>
				{#each starred as m (m.provider + m.id)}{@render opt(m, true)}{/each}
			{/if}
			{#each shown as g (g.id)}
				<div class="gname">{g.name}{#if !g.configured} <span class="chip">{t("키 없음")}</span>{/if}</div>
				{#each g.models as m (m.id)}{@render opt(m, false)}{/each}
			{/each}
			{#if !starred.length && !shown.length}
				<div class="empty">{t("일치하는 모델이 없습니다")}</div>
			{/if}
		</div>

		<div class="sec" class:gone={!sel}>
			<div class="slabel">{t("추론 강도")}</div>
			<div class="seg" class:off={!reasoning} role="group" aria-label={t("추론 강도")} use:slidingIndicator={{ selector: "button.on", variant: "level", radius: "calc(var(--radius) - 3px)", mirror: ["data-level"] }}>
				{#each available as l (l)}
					<button type="button" class:on={shownLvl === l} aria-pressed={shownLvl === l} data-level={l} disabled={!reasoning || !sel} onclick={() => (lvl = l)}>{l}</button>
				{/each}
			</div>
			{#if info && !info.reasoning}<div class="note">{t("이 모델은 추론 모드를 지원하지 않습니다.")}</div>{/if}
		</div>
	</div>

	<footer>
		{#if onmanage}<button type="button" class="manage" onclick={() => { onclose(); onmanage(); }}><Icon name="settings" /> {t("연결 관리")}</button>{/if}
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
		min-height: 120px;
		overflow-y: auto;
		margin: 0 -6px;
		padding: 0 6px;
	}
	.gname {
		display: flex;
		align-items: center;
		gap: 8px;
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
	.opt.dim {
		opacity: 0.5;
	}
	.opt :global(svg) {
		width: 17px;
		height: 17px;
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
	}
	.fav {
		flex: none;
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		opacity: 0;
	}
	.orow:hover .fav,
	.fav:focus-visible,
	.fav.on {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.fav {
			opacity: 1;
		}
	}
	.fav:hover {
		color: var(--text);
	}
	.fav :global(svg) {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linejoin: round;
	}
	.fav.on {
		color: var(--warn);
	}
	.fav.on :global(svg) {
		fill: currentColor;
	}
	.gstar :global(svg) {
		width: 12px;
		height: 12px;
		stroke: currentColor;
		fill: currentColor;
		stroke-width: 1.8;
		stroke-linejoin: round;
	}
	.empty {
		padding: 16px;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.sec {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.sec.gone {
		opacity: 0.4;
	}
	.slabel {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: lowercase;
		color: var(--text-faint);
	}
	.seg {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(0, 1fr);
	}
	.seg button {
		padding: 0;
		font-size: var(--fs-2xs);
	}
	.seg button:not(.on):not(:disabled)::before {
		content: "";
		display: inline-block;
		width: 5px;
		height: 5px;
		margin-right: 5px;
		border-radius: 50%;
		background: var(--lv);
		opacity: 0.55;
		vertical-align: 1px;
	}
	.seg button.on {
		background: var(--lv-soft);
		color: var(--lv);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lv) 45%, transparent);
		font-weight: 600;
	}
	.seg:global([data-indicator-ready]) button.on {
		background: transparent;
		box-shadow: none;
	}
	.seg.off :global(.slide-ind) {
		opacity: 0.35;
	}
	.note {
		font-size: var(--fs-xs);
		color: var(--text-faint);
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
	.manage {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-sm);
	}
	.manage:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.manage :global(svg) {
		width: 15px;
		height: 15px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	@media (max-width: 640px) {
		.search {
			font-size: var(--fs-lg); /* below 16px iOS zooms the page when the field is focused */
		}
		.seg button {
			font-size: var(--fs-2xs);
		}
	}
</style>
