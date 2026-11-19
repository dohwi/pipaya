<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";

	/**
	 * Closing a conversation that is still at work (tab X, the row menu, the shortcut): asks once, through the shared
	 * ConfirmDialog. "Keep open" takes focus, so a stray Enter never cuts the work off.
	 */
	let last = $state<NonNullable<typeof app.sessionCloseConfirm> | null>(null);
	$effect(() => {
		if (app.sessionCloseConfirm) last = app.sessionCloseConfirm;
	});
	const shown = $derived(app.sessionCloseConfirm ?? last);
	const cancel = () => app.sessionCloseConfirm?.cancel();
	const ok = () => app.sessionCloseConfirm?.confirm();
</script>

{#if app.sessionCloseConfirm}
	<ConfirmDialog
		id="session-close"
		title={shown?.hold === "asking" ? t("답을 기다리는 대화를 닫을까요?") : t("작업 중인 대화를 닫을까요?")}
		description={t("‘{name}’의 작업이 중단됩니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name: shown?.title ?? "" })}
		oncancel={cancel}
		actions={[
			{ label: t("계속 두기"), variant: "primary", onclick: cancel },
			{ label: t("중단하고 닫기"), variant: "ghost", destructive: true, onclick: ok },
		]}
	/>
{/if}
