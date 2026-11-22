<script lang="ts">
	import { t } from "../../lib/i18n";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";
	import Switch from "../ui/Switch.svelte";

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
		<!-- the visible name beside the switch; a click on it flips the switch too, as the checkbox label did -->
		<div class="wipe-row">
			<Switch checked={wipe} label={t("설정값도 함께 삭제")} disabled={busy} onchange={(on) => (wipe = on)} />
			<button type="button" class="wipe-name" tabindex={-1} aria-hidden="true" disabled={busy} onclick={() => (wipe = !wipe)}>{t("설정값도 함께 삭제")}</button>
		</div>
	{/if}
</ConfirmDialog>

<style>
	.wipe-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; }
	.wipe-name { font-size: var(--fs-sm); line-height: 20px; color: var(--text-dim); }
</style>
