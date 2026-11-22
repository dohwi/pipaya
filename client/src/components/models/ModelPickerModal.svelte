<script lang="ts">
	import type { ActionId } from "../../lib/keys";
	import type { Api } from "../../lib/api";
	import TierOptions from "./TierOptions.svelte";
	import type { ServiceTier } from "../../lib/types";
	import { t } from "../../lib/i18n";
	import Ladder from "../ui/Ladder.svelte";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import Badge from "../ui/Badge.svelte";
	import PickerModal from "../ui/PickerModal.svelte";
	import ModelLogo from "./ModelLogo.svelte";
	import PickerOption from "../ui/PickerOption.svelte";
	import { capsOf } from "../../lib/model-caps";
	import { THINKING_LEVELS, type ModelInfo, type ProviderInfo, type ThinkingLevel } from "../../lib/types";

	/**
	 * The one place a model is chosen. A model and its reasoning strength are a pair: the list picks the model, the
	 * strength row sits right under it, and `onpick` always reports both. Every setting that selects a model (the
	 * composer, the new-chat default, compaction) opens this same dialog.
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
		tier = null,
		tierApi,
		favs = [],
		allowUnset = false,
		unsetLabel,
		title,
		onpick,
		onfav,
		onmanage,
		conn = null,
		closeShortcut,
		onclose,
	}: {
		models: ModelInfo[];
		providers?: ProviderInfo[];
		value: { provider: string; model: string } | null;
		level?: ThinkingLevel | null;
		tier?: ServiceTier | null;
		tierApi?: Api | null;
		favs?: string[];
		allowUnset?: boolean;
		unsetLabel?: string;
		title?: string;
		onpick: (choice: { provider: string; model: string; thinkingLevel?: ThinkingLevel; serviceTier?: ServiceTier | null } | null) => void;
		/** Star a model; omit to hide the stars */
		onfav?: (provider: string, id: string) => void;
		onmanage?: () => void;
		conn?: { baseUrl: string; token: string } | null;
		closeShortcut?: ActionId;
		onclose: () => void;
	} = $props();

	const levels: ThinkingLevel[] = [...THINKING_LEVELS];

	let filter = $state("");
	/** What is chosen now. Every click (model, strength, unset) is applied at once through `onpick`; the dialog stays open. */
	// svelte-ignore state_referenced_locally
	let sel = $state<{ provider: string; model: string } | null>(value);
	// svelte-ignore state_referenced_locally
	let lvl = $state<ThinkingLevel | null>(level);

	const key = (p: string, id: string) => `${p}\u0000${id}`;
	const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
	const isFav = (m: ModelInfo) => favs.includes(key(m.provider, m.id));
	const matches = (m: ModelInfo) => !filter || `${providerName(m.provider)} ${m.name} ${m.id}`.toLowerCase().includes(filter.toLowerCase());
	const info = $derived(sel ? models.find((m) => m.provider === sel!.provider && m.id === sel!.model) : undefined);
	// Nothing picked: offer strengths only when some listed model reasons (the image model list has none).
	const reasoning = $derived(info ? info.reasoning : models.some((m) => m.reasoning));
	/** Only the strengths this model accepts. */
	const available = $derived<ThinkingLevel[]>(info?.thinkingLevels.length ? levels.filter((l) => info.thinkingLevels.includes(l)) : levels);
	/** The highlighted strength, moved to the nearest supported one when the model does not accept it. */
	const shownLvl = $derived.by<ThinkingLevel | null>(() => {
		// A model with reasoning always has a strength selected: when none was chosen yet, start at the model's own default.
		const want = lvl ?? (info?.reasoning ? (info.defaultThinkingLevel ?? "medium") : null);
		if (!want || available.includes(want)) return want;
		const i = levels.indexOf(want);
		return available.find((l) => levels.indexOf(l) >= i) ?? available[available.length - 1] ?? null;
	});

	const groups = $derived.by(() => {
		const by = new Map<string, ModelInfo[]>();
		for (const m of models) {
			if (!by.has(m.provider)) by.set(m.provider, []);
			by.get(m.provider)!.push(m);
		}
		return [...by.entries()]
			// models the upstream no longer lists go last in their group (the connection card does the same)
			.map(([id, list]) => ({ id, name: providerName(id), configured: list.some((m) => m.configured), models: [...list].sort((a, b) => Number(a.available === false) - Number(b.available === false)) }))
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	});
	const shown = $derived(groups.map((g) => ({ ...g, models: g.models.filter((m) => !isFav(m) && matches(m)) })).filter((g) => g.models.length));
	const starred = $derived(favs.map((k) => models.find((m) => key(m.provider, m.id) === k)).filter((m): m is ModelInfo => !!m && matches(m)));

	/** "컨텍스트 400,000 · 최대 출력 4,096" (a picture model has no context size). */
	const limits = (m: ModelInfo) =>
		[m.imageGeneration ? "" : t("컨텍스트 {n}", { n: m.contextWindow.toLocaleString() }), t("최대 출력 {n}", { n: m.maxTokens.toLocaleString() })].filter(Boolean).join(" · ");
	/** The row's tooltip: abilities, then sizes ("채팅 · 추론 · 이미지 읽기 — 컨텍스트 400,000 · 최대 출력 4,096"). */
	const tipOf = (m: ModelInfo) => `${capsOf(m).map((c) => t(c.label)).join(" · ")}\n${limits(m)}`;
	const same = (m: ModelInfo) => !!sel && sel.provider === m.provider && sel.model === m.id;
	const selectedTier = $derived(sel?.provider === value?.provider && sel?.model === value?.model ? tier : null);
	function apply(speed = selectedTier, inherit = false) {
		if (!sel) return onpick(null);
		onpick({ provider: sel.provider, model: sel.model, ...(!inherit && tierApi && (info?.openRouterTiers || tier) ? { serviceTier: info?.openRouterTiers ? speed : null } : {}), ...(shownLvl && reasoning ? { thinkingLevel: shownLvl } : {}) });
	}
	function choose(m: ModelInfo) {
		if (!m.configured || m.available === false || same(m)) return;
		sel = { provider: m.provider, model: m.id };
		// A model that names its own starting strength starts there; one that does not keeps the choice made here.
		if (m.defaultThinkingLevel) lvl = null;
		// No speed is sent: the chat (or draft) starts the new model at the speed a new chat with it would, the same rule as on the server.
		apply(null, true);
	}
	function unset() {
		if (!sel) return;
		sel = null;
		apply();
	}
	function strength(l: ThinkingLevel) {
		if (l === shownLvl) return;
		lvl = l;
		apply();
	}
</script>

{#snippet opt(m: ModelInfo, inFavs: boolean)}
	{@const fav = isFav(m)}
	<PickerOption tip={tipOf(m)} selected={same(m)} disabled={!m.configured || m.available === false} onclick={() => choose(m)}>
		{#snippet lead()}<ModelLogo {conn} icon={m.icon} provider={m.provider} model={m.id} size={20} colored={Boolean(m.icon)} />{/snippet}
		{#snippet name()}{m.name}{/snippet}
		{#snippet meta()}{#if inFavs}<span>{providerName(m.provider)}</span>{/if}{#if m.available === false}<span>{t("불러오지 못함")}</span>{:else if !m.configured}<span>{t("키 없음")}</span>{/if}{/snippet}
		{#snippet trailing()}
			{#if onfav}
				<button type="button" class="fav" class:on={fav} onclick={() => onfav(m.provider, m.id)} aria-pressed={fav} aria-label={t("{name} 즐겨찾기", { name: m.name })} title={fav ? t("즐겨찾기 해제") : t("즐겨찾기")}>
					<Icon name="star" />
				</button>
			{/if}
		{/snippet}
	</PickerOption>
{/snippet}

<!-- opened from the composer (over the page) or from settings: the top layer works for both -->
<PickerModal {closeShortcut} title={title ?? t("모델 선택")} {onclose} bind:query={filter} placeholder={t("모델 검색")} empty={!starred.length && !shown.length ? t("일치하는 모델이 없습니다") : undefined}>
	{#snippet list()}
		{#if allowUnset}
			<PickerOption selected={!sel} onclick={unset}>
				{#snippet name()}{unsetLabel ?? t("지정 안 함")}{/snippet}
				<!-- the star's width, so this row's check lines up with the model rows' -->
				{#snippet trailing()}{#if onfav}<span class="favslot" aria-hidden="true"></span>{/if}{/snippet}
			</PickerOption>
		{/if}
		{#if starred.length}
			<div class="pk-group"><span class="gstar"><Icon name="star" /></span>{t("즐겨찾기")}</div>
			{#each starred as m (m.provider + m.id)}{@render opt(m, true)}{/each}
		{/if}
		{#each shown as g (g.id)}
			<div class="pk-group">{g.name}{#if !g.configured} <Badge size="sm">{t("키 없음")}</Badge>{/if}</div>
			{#each g.models as m (m.id)}{@render opt(m, false)}{/each}
		{/each}
	{/snippet}

	{#snippet after()}
		{#if reasoning}
		<div class="sec" in:collapseIn out:collapseOut>
			<div class="section-label">{t("추론 강도")}</div>
			<Ladder label={t("추론 강도")} options={available.map((l) => ({ id: l, label: l, level: l }))} value={shownLvl} disabled={!sel} onchange={strength} />
		</div>
		{/if}
		{#if tierApi && info && (info.openRouterTiers || selectedTier) && !info.imageGeneration}
			{#key info.provider + ":" + info.id}<TierOptions api={tierApi} model={info.id} lookup={!!info.openRouterTiers} value={selectedTier} onchange={apply} />{/key}
		{/if}
	{/snippet}

	{#snippet footerStart()}
		{#if onmanage}<button type="button" class="manage" onclick={() => { onclose(); onmanage(); }}><Icon name="settings" /> {t("연결 관리")}</button>{/if}
	{/snippet}
</PickerModal>

<style>
	.favslot {
		flex: none;
		width: 34px;
		height: 34px;
	}
	.fav {
		flex: none;
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		color: var(--text-faint);
		opacity: 0;
		transition:
			opacity var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			scale var(--motion-fast) var(--ease);
	}
	:global(.pk-row:hover) .fav,
	.fav:focus-visible,
	.fav.on {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.fav {
			opacity: 1;
		}
	}
	@media (hover: hover) {
		.fav:hover {
			color: var(--text);
		}
	}
	.fav:active {
		scale: 0.85;
	}
	.fav :global(svg) {
		width: 16px;
		height: 16px;
		stroke-width: 1.8;
		transition: fill var(--motion-fast) var(--ease-std);
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
		fill: currentColor;
		stroke-width: 1.8;
	}
	.sec {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.manage {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: var(--control-h-sm);
		padding: 0 8px;
		margin-left: -8px; /* the glyph, not the button, on the footer's 16px gutter (rule 5): the title and the search field start there too */
		border-radius: var(--radius-control);
		color: var(--text-dim);
		font-size: var(--fs-sm);
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.manage:hover {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	.manage :global(svg) {
		width: 15px;
		height: 15px;
		stroke-width: 1.9;
	}
</style>
