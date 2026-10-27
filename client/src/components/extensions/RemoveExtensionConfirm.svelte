<script lang="ts">
	import { t } from "../../lib/i18n";
	import ConfirmDialog, { type ConfirmAction } from "../ConfirmDialog.svelte";

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

	const actions = $derived<ConfirmAction[]>([
		...(keepable ? [{ label: t("설정 유지하고 삭제"), onclick: onkeep }] : []),
		{ label: keepable ? t("설정까지 삭제") : t("삭제"), variant: "danger", onclick: onwipe },
		{ label: t("취소"), variant: "ghost", focus: true, onclick: oncancel },
	]);
</script>

<ConfirmDialog
	id="rm"
	icon="trash"
	tone="danger"
	{busy}
	title={t("‘{name}’을 삭제할까요?", { name })}
	description={keepable ? t("이 확장을 삭제합니다. 설정값은 어떻게 할까요?") : t("이 항목을 삭제합니다. 되돌릴 수 없습니다.")}
	{oncancel}
	{actions}
/>
