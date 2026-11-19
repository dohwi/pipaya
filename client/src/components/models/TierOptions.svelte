<script lang="ts">
	import type { Api } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import type { ServiceTier } from "../../lib/types";
	import { tierLabel } from "../../lib/service-tier";
	import Segmented from "../ui/Segmented.svelte";

	let { api, model, value = null, lookup = true, label = t("응답 속도"), onchange }: {
		api: Api; model: string; lookup?: boolean; label?: string; value?: ServiceTier | null; onchange?: (v: ServiceTier | null) => void;
	} = $props();
	let tiers = $state<ServiceTier[]>([]);
	let failed = $state(false);
	const choices = $derived<ServiceTier[]>(lookup ? ["default", ...tiers.filter(id => id !== "default")] : []);
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

{#if onchange && (lookup || value)}
	<div class="tier-row">
		<div class="section-label">{label}</div>
		<Segmented size="sm" {label} value={value ?? "auto"}
			options={[{ id: "auto" as const, label: t("자동") }, ...choices.map(id => ({ id, label: tierLabel(id) })), ...(value && !choices.includes(value) ? [{ id: value, label: tierLabel(value), disabled: true }] : [])]}
			onchange={id => onchange?.(id === "auto" ? null : id)} />
		<small class="hint">{t("자동은 OpenRouter 설정을 따르고, 표준은 가속을 끕니다.")}{#if tiers.some(id => id === "priority" || id === "ultrafast")} {t("고속 등급은 추가 요금이 들 수 있습니다.")}{/if}</small>
	</div>
{:else if !onchange && tiers.length}
	<p class="hint note">{t("OpenRouter 응답 등급: {tiers} (참고용)", { tiers: tiers.map(tierLabel).join(", ") })}</p>
{/if}
{#if failed}<small class="hint">{t("응답 등급을 확인하지 못했습니다.")}</small>{/if}

<style>
	.tier-row { display: grid; gap: 4px; }
</style>
