<script lang="ts">
	import Button from "../Button.svelte";
	import Icon from "../Icon.svelte";
	import Modal from "../Modal.svelte";
	import { t } from "../../lib/i18n";

	/** "Delete this extension?" as a small dialog over the marketplace: keep its settings, delete them too, or nothing. */
	let { name, busy = false, keepable = true, onkeep, onwipe, oncancel }: {
		name: string;
		busy?: boolean;
		/** false: there are no settings to keep (an unreadable entry without an id), so it is just delete or cancel */
		keepable?: boolean;
		onkeep: () => void;
		onwipe: () => void;
		oncancel: () => void;
	} = $props();
</script>

<Modal onclose={oncancel} role="alertdialog" labelledby="rm-title" describedby="rm-desc" width="s" layer={4} portal>
	<div class="rc">
		<span class="mark"><Icon name="trash" /></span>
		<h3 id="rm-title">{t("‘{name}’을 삭제할까요?", { name })}</h3>
		<p id="rm-desc">{keepable ? t("이 확장을 삭제합니다. 설정값은 어떻게 할까요?") : t("이 항목을 삭제합니다. 되돌릴 수 없습니다.")}</p>
		<div class="btns">
			{#if keepable}<Button disabled={busy} onclick={onkeep}>{t("설정 유지하고 삭제")}</Button>{/if}
			<Button variant="danger" disabled={busy} onclick={onwipe}>{keepable ? t("설정까지 삭제") : t("삭제")}</Button>
			<Button variant="ghost" disabled={busy} onclick={oncancel} focus>{t("취소")}</Button>
		</div>
	</div>
</Modal>

<style>
	.rc { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px 20px calc(16px + var(--sab)); text-align: center; }
	.mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 6px; border-radius: 50%; background: var(--danger-soft); color: var(--danger); }
	.mark :global(svg) { width: 22px; height: 22px; stroke-width: 1.8; }
	h3 { margin: 0; font-size: var(--fs-lg); overflow-wrap: anywhere; }
	p { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }
	.btns { display: flex; flex-direction: column; gap: 8px; align-self: stretch; margin-top: 16px; }
	.btns :global(.btn) { width: 100%; }
</style>
