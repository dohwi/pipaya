<script lang="ts">
	import { t } from "../lib/i18n";

	/**
	 * Title line of an update panel: the section label on the left, the "check for updates" button on the right
	 * (its refresh arrow spins while `checking`).
	 */
	let {
		label,
		checking = false,
		disabled = false,
		onclick,
	}: {
		label: string;
		checking?: boolean;
		disabled?: boolean;
		onclick: () => void;
	} = $props();
</script>

<div class="head">
	<div class="section-title">{label}</div>
	<button class="btn sm" {disabled} {onclick}>
		<svg class:spin={checking} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
		{checking ? t("확인하는 중…") : t("업데이트 확인")}
	</button>
</div>

<style>
	.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
	.btn { flex: none; white-space: nowrap; }
	.btn svg { width: 14px; height: 14px; }
</style>
