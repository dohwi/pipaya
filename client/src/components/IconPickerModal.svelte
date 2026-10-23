<script lang="ts">
	import { t } from "../lib/i18n";
	import { ICON_LABEL } from "../lib/brand";
	import ModelLogo from "./ModelLogo.svelte";
	import PickerModal from "./PickerModal.svelte";

	/** Pick a model's icon from a grid, like an emoji picker: search by name, click to pick (the caller closes). "Auto" follows the model id. */
	let {
		value,
		provider,
		model,
		onpick,
		onclose,
	}: {
		value: string | undefined;
		provider: string;
		model: string;
		onpick: (icon: string | undefined) => void;
		onclose: () => void;
	} = $props();

	let query = $state("");
	const q = $derived(query.trim().toLowerCase());
	const hits = $derived(Object.entries(ICON_LABEL).filter(([k, label]) => !q || k.includes(q) || label.toLowerCase().includes(q)));
	const showAuto = $derived(!q || t("자동").toLowerCase().includes(q) || "auto".includes(q));
</script>

<PickerModal title={t("아이콘")} {onclose} bind:query placeholder={t("아이콘 검색")} width="400px" minList="220px">
	{#snippet list()}
		<div class="grid" role="group" aria-label={t("아이콘")}>
			{#if showAuto}
				<button type="button" class="pk-opt cell" aria-pressed={!value} title={t("자동")} onclick={() => onpick(undefined)}>
					<ModelLogo {provider} {model} size={26} /><span>{t("자동")}</span>
				</button>
			{/if}
			{#each hits as [k, label] (k)}
				<button type="button" class="pk-opt cell" aria-pressed={value === k} title={label} onclick={() => onpick(k)}>
					<ModelLogo icon={k} size={26} colored /><span>{label}</span>
				</button>
			{/each}
		</div>
		{#if !showAuto && !hits.length}<p class="none">{t("일치하는 항목이 없습니다")}</p>{/if}
	{/snippet}
</PickerModal>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
		gap: 6px;
		padding: 4px 0;
	}
	.cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 72px;
		padding: 6px 4px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-2xs);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.cell span {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cell:hover,
	.cell:focus-visible {
		background: var(--bg-hover);
		color: var(--text);
	}
	.cell[aria-pressed="true"] {
		border-color: var(--accent, var(--text));
		color: var(--text);
	}
	.none {
		margin: 16px 0;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
</style>
