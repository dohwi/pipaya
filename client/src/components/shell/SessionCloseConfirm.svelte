<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";

	/**
	 * Closing a tab that needs confirmation (working/asking conversation, or a pinned conversation/terminal — via tab X,
	 * row menu, or shortcut): asks once, through the shared ConfirmDialog. "Keep open" takes focus, so a stray Enter never
	 * closes it by accident.
	 */
	let last = $state<NonNullable<typeof app.sessionCloseConfirm> | null>(null);
	$effect(() => {
		if (app.sessionCloseConfirm) last = app.sessionCloseConfirm;
	});
	const shown = $derived(app.sessionCloseConfirm ?? last);
	const cancel = () => app.sessionCloseConfirm?.cancel();
	const ok = () => app.sessionCloseConfirm?.confirm();

	const title = $derived.by(() => {
		switch (shown?.hold) {
			case "asking": return t("답을 기다리는 대화를 닫을까요?");
			case "pinned": return t("고정된 대화를 닫을까요?");
			case "pinned-terminal": return t("고정된 터미널을 닫을까요?");
			default: return t("작업 중인 대화를 닫을까요?");
		}
	});
	const description = $derived.by(() => {
		const name = shown?.title ?? "";
		switch (shown?.hold) {
			case "pinned": return t("‘{name}’의 고정이 해제됩니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name });
			case "pinned-terminal": return t("‘{name}’의 고정이 해제되고 셸이 종료됩니다.", { name });
			default: return t("‘{name}’의 작업이 중단됩니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name });
		}
	});
	const confirmLabel = $derived(
		shown?.hold === "pinned"
			? t("닫기")
			: shown?.hold === "pinned-terminal"
				? t("종료하고 닫기")
				: t("중단하고 닫기"),
	);
</script>

{#if app.sessionCloseConfirm}
	<ConfirmDialog
		id="session-close"
		{title}
		{description}
		oncancel={cancel}
		actions={[
			{ label: t("계속 두기"), variant: "primary", onclick: cancel },
			{ label: confirmLabel, variant: "ghost", destructive: true, onclick: ok },
		]}
	/>
{/if}
