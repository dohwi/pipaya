<script lang="ts">
	import { t } from "../../lib/i18n";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";

	/**
	 * "Install the other one too?" for two extensions that only work together. The user sees two extensions, not a
	 * server half and a client half; the answer is both, only the one that was picked, or nothing. Neutral on purpose:
	 * orange stays for "one of them is missing".
	 */
	let { picked, other, onboth, onsolo, oncancel }: {
		picked: { name: string };
		other: { name: string };
		onboth: () => void;
		onsolo: () => void;
		oncancel: () => void;
	} = $props();
</script>

<ConfirmDialog
	id="pair"
	icon="clip"
	tone="neutral"
	title={t("함께 설치할까요?")}
	description={t("두 확장은 함께 작동합니다. 한쪽만 있으면 동작하지 않습니다.")}
	{oncancel}
	actions={[
		{ label: t("함께 설치"), variant: "primary", onclick: onboth },
		{ label: t("‘{name}’만 설치", { name: picked.name }), onclick: onsolo },
		{ label: t("취소"), variant: "ghost", onclick: oncancel },
	]}
>
	<ul class="rows">
		<li><strong>{picked.name}</strong></li>
		<li><strong>{other.name}</strong></li>
	</ul>
</ConfirmDialog>

<style>
	.rows { list-style: none; margin: 12px 0 0; padding: 0; align-self: stretch; display: flex; flex-direction: column; gap: 4px; }
	.rows li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); font-size: var(--fs-sm); }
</style>
