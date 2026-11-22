<script lang="ts">
	import type { Api } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import type { ServiceTier } from "../../lib/types";
	import { tierLabel } from "../../lib/service-tier";
	import Ladder from "../ui/Ladder.svelte";

	let { api, model, value = null, lookup = true, label = t("응답 속도"), onchange }: {
		api: Api; model: string; lookup?: boolean; label?: string; value?: ServiceTier | null; onchange?: (v: ServiceTier | null) => void;
	} = $props();
	let tiers = $state<ServiceTier[]>([]);
	let failed = $state(false);
	/** Slow to fast, so the row reads like the strength ladder beside it: flex, standard, then the paid fast tiers. */
	const ORDER: ServiceTier[] = ["flex", "default", "priority", "ultrafast"];
	const choices = $derived<ServiceTier[]>(lookup ? ORDER.filter(id => id === "default" || tiers.includes(id)) : []);
	/** The tiers that may cost extra carry the warn colour when chosen; the rest the text colour. */
	const paid = (id: ServiceTier) => id === "priority" || id === "ultrafast";
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
		<div class="stack">
		<Ladder {label} value={value ?? "auto"}
			options={[{ id: "auto" as const, label: t("자동") }, ...choices.map(id => ({ id, label: tierLabel(id), color: paid(id) ? "var(--warn)" : undefined })), ...(value && !choices.includes(value) ? [{ id: value, label: tierLabel(value), disabled: true }] : [])]}
			onchange={id => onchange?.(id === "auto" ? null : id)} />
		<small class="hint">{t("자동은 OpenRouter 설정을 따르고, 표준은 가속을 끕니다.")}{#if tiers.some(id => id === "priority" || id === "ultrafast")} {t("고속 등급은 추가 요금이 들 수 있습니다.")}{/if}</small>
		</div>
	</div>
{:else if !onchange && tiers.length}
	<p class="hint note">{t("OpenRouter 응답 등급: {tiers}. 속도는 OpenRouter에 직접 연결할 때만 고를 수 있습니다.", { tiers: tiers.map(tierLabel).join(", ") })}</p>
{/if}
{#if failed}<small class="hint">{t("응답 등급을 확인하지 못했습니다.")}</small>{/if}

<style>
	/* label, ladder, then its hint 4px under it: the same stack as the effort ladders on the model page */
	.tier-row { display: grid; gap: 8px; }
	.stack { display: grid; gap: 4px; }
	/* a <p> here sits in a flex column with its own gap: the browser's 1em margins doubled the space around it */
	.note { margin: 0; }
</style>
