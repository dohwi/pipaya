<script lang="ts">
	import { t } from "../../lib/i18n";
	import ConfirmDialog from "../ConfirmDialog.svelte";

	/**
	 * "Delete this extension?" over the marketplace or its page: delete or cancel, with one box for its settings. Settings are kept
	 * unless the box is ticked, because that is the part that cannot be brought back.
	 */
	let { name, busy = false, keepable = true, onkeep, onwipe, oncancel }: {
		name: string;
		busy?: boolean;
		/** false: there are no settings to keep (an unreadable entry without an id), so it is just delete or cancel */
		keepable?: boolean;
		onkeep: () => void;
		onwipe: () => void;
		oncancel: () => void;
	} = $props();

	let wipe = $state(false);
</script>

<ConfirmDialog
	id="rm"
	icon="trash"
	tone="danger"
	{busy}
	title={t("‘{name}’을 삭제할까요?", { name })}
	description={keepable ? t("설정값은 남겨 두고, 같은 확장을 다시 설치하면 이어서 씁니다.") : t("이 항목을 삭제합니다. 되돌릴 수 없습니다.")}
	{oncancel}
	actions={[
		{ label: t("삭제"), variant: "danger", onclick: () => (keepable && !wipe ? onkeep() : onwipe()) },
		{ label: t("취소"), variant: "ghost", focus: true, onclick: oncancel },
	]}
>
	{#if keepable}
		<label class="wipe"><input type="checkbox" bind:checked={wipe} disabled={busy} /> {t("설정값도 함께 삭제")}</label>
	{/if}
</ConfirmDialog>

<style>
	.wipe { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; font-size: var(--fs-sm); color: var(--text-dim); cursor: pointer; }
</style>
