<script lang="ts">
	import type { Api } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { tierLabel, type ServiceTier } from "../../lib/types";
	import Segmented from "../ui/Segmented.svelte";

	let { api, model, value = null, lookup = true, onchange }: {
		api: Api; model: string; lookup?: boolean; value?: ServiceTier | null; onchange?: (v: ServiceTier | null) => void;
	} = $props();
	let tiers = $state<ServiceTier[]>([]);
	let failed = $state(false);
	$effect(() => {
		tiers = []; failed = false;
		if (!lookup) return;
		const controller = new AbortController();
		api.scoped(controller.signal).catalogTiers(model).then(result => {
			if (!controller.signal.aborted) tiers = result.tiers;
		}).catch(() => { if (!controller.signal.aborted) failed = true; });
		return () => controller.abort();
	});
</script>

{#if onchange && (tiers.length || value)}
	<div class="tier-row">
		<div class="section-label">{t("응답 속도")}</div>
		<Segmented size="sm" label={t("응답 속도")} value={value ?? "auto"}
			options={[{ id: "auto" as const, label: t("연결 기본값") }, ...tiers.map(id => ({ id, label: tierLabel(id) })), ...(value && !tiers.includes(value) ? [{ id: value, label: tierLabel(value), disabled: true }] : [])]}
			onchange={id => onchange?.(id === "auto" ? null : id)} />
		{#if tiers.some(id => id !== "flex")}<small class="hint">{t("Fast와 Ultrafast는 추가 요금이 발생할 수 있습니다.")}</small>{/if}
	</div>
{:else if !onchange && tiers.length}
	<p class="hint note">{t("OpenRouter 응답 등급: {tiers} (참고용)", { tiers: tiers.map(tierLabel).join(", ") })}</p>
{/if}
{#if failed}<small class="hint">{t("응답 등급을 확인하지 못했습니다.")}</small>{/if}

<style>
	.tier-row { display: grid; gap: 4px; }
</style>
