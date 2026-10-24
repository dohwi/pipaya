<script lang="ts">
	import { onMount } from "svelte";
	import { errorText, type Api } from "../lib/api";
	import { iconFileToBase64 } from "../lib/model-icon-image";
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { ICON_ALIASES, ICON_LABEL, MAKER_ICONS, PIPAYA_ICON } from "../lib/brand";
	import ModelLogo from "./ModelLogo.svelte";
	import PickerModal from "./PickerModal.svelte";

	/** Pick a model's icon from a grid, like an emoji picker: search by name, click to pick (the caller closes). "Auto" follows the model id. */
	let {
		value,
		provider,
		model,
		api,
		onpick,
		onclose,
	}: {
		value: string | undefined;
		provider: string;
		model: string;
		/** The server the model belongs to: uploaded images are stored there. */
		api: Api | null;
		onpick: (icon: string | undefined) => void;
		onclose: () => void;
	} = $props();

	let query = $state("");
	/** Images already uploaded to the server (so one picture can be reused by several models). */
	let uploaded = $state<string[]>([]);
	let uploading = $state(false);
	let error = $state("");
	let file = $state<HTMLInputElement | null>(null);
	onMount(() => { void api?.listIcons().then((r) => (uploaded = r.icons)).catch(() => {}); });

	async function upload(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0];
		(e.currentTarget as HTMLInputElement).value = "";
		if (!f || !api) return;
		error = "";
		uploading = true;
		try {
			onpick((await api.uploadIcon(await iconFileToBase64(f))).icon);
		} catch (err) {
			error = errorText(err);
		} finally {
			uploading = false;
		}
	}
	const q = $derived(query.trim().toLowerCase());
	const offered: string[] = [PIPAYA_ICON, ...MAKER_ICONS];
	const hits = $derived(offered.filter((k) => !q || `${k} ${ICON_LABEL[k]} ${ICON_ALIASES[k] ?? ""}`.toLowerCase().includes(q)));
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
			{#each hits as k (k)}
				{@const label = ICON_LABEL[k]}
				<button type="button" class="pk-opt cell" aria-pressed={value === k} title={label} onclick={() => onpick(k)}>
					<ModelLogo icon={k} size={26} colored /><span>{label}</span>
				</button>
			{/each}
			{#if !q}
				{#each uploaded as u (u)}
					<button type="button" class="pk-opt cell" aria-pressed={value === u} title={t("올린 이미지")} onclick={() => onpick(u)}>
						<ModelLogo conn={api?.connection} icon={u} size={26} /><span>{t("올린 이미지")}</span>
					</button>
				{/each}
				{#if api}
					<button type="button" class="pk-opt cell plus" disabled={uploading} title={t("이미지 추가")} onclick={() => file?.click()}>
						<Icon name="plus" /><span>{uploading ? t("올리는 중…") : t("이미지 추가")}</span>
					</button>
				{/if}
			{/if}
		</div>
		{#if api && !q}
			<input bind:this={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onchange={upload} />
			<p class="hint">{t("PNG·JPEG·WebP, 정사각형에 가까울수록 좋습니다. 서버에 저장되어 모든 기기에서 보입니다.")}</p>
			{#if error}<p class="err" role="alert">{error}</p>{/if}
		{/if}
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
	.plus {
		border: 1px dashed var(--border-strong);
	}
	.plus :global(svg) {
		width: 22px;
		height: 22px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
	}
	.hint,
	.err {
		margin: 6px 4px 0;
	}
	.err {
		color: var(--danger);
	}
	.none {
		margin: 16px 0;
		text-align: center;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
</style>
