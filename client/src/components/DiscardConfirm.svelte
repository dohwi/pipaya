<script lang="ts">
	import { t } from "../lib/i18n";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	/**
	 * "Close without saving?" sheet for a dialog with unsaved edits: save, keep editing, or discard.
	 * Saving is the default answer and gets focus.
	 */
	let { onsave, oncancel, ondiscard }: { onsave: () => void; oncancel: () => void; ondiscard: () => void } = $props();
</script>

<ConfirmDialog
	id="unsaved"
	layer={5}
	title={t("저장하지 않고 닫을까요?")}
	description={t("저장되지 않은 변경이 있습니다.")}
	{oncancel}
	actions={[
		{ label: t("저장"), variant: "primary", onclick: onsave },
		{ label: t("계속 편집"), onclick: oncancel },
		{ label: t("저장하지 않고 닫기"), variant: "ghost", destructive: true, onclick: ondiscard },
	]}
/>
