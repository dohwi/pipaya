<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";

	/**
	 * Closing a tab that needs confirmation (working/asking conversation, a conversation with active scheduled tasks, or a
	 * pinned conversation/terminal — via tab X, row menu, or shortcut): asks once, through the shared ConfirmDialog. "Keep
	 * open" takes focus, so a stray Enter never closes it by accident.
	 */
	let last = $state<NonNullable<typeof app.sessionCloseConfirm> | null>(null);
	$effect(() => {
		if (app.sessionCloseConfirm) last = app.sessionCloseConfirm;
	});
	const shown = $derived(app.sessionCloseConfirm ?? last);
	const cancel = () => app.sessionCloseConfirm?.cancel();
	const ok = () => app.sessionCloseConfirm?.confirm();

	const icon = $derived<"clock" | "alert">(shown?.hold === "scheduled" ? "clock" : "alert");
	const title = $derived.by(() => {
		switch (shown?.hold) {
			case "asking": return t("답을 기다리는 대화를 닫을까요?");
			case "scheduled": return t("예약 작업이 있는 대화를 닫을까요?");
			case "pinned": return t("고정된 대화를 닫을까요?");
			case "pinned-terminal": return t("고정된 터미널을 닫을까요?");
			default: return t("작업 중인 대화를 닫을까요?");
		}
	});
	const description = $derived.by(() => {
		const name = shown?.title ?? "";
		const n = shown?.scheduledCount ?? 0;
		switch (shown?.hold) {
			case "scheduled":
				return shown?.pinned
					? t("‘{name}’의 고정이 해제되고, 예약 작업 {n}개는 닫힌 동안 건너뜁니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name, n: Math.max(1, n) })
					: t("‘{name}’의 예약 작업 {n}개는 닫힌 동안 건너뜁니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name, n: Math.max(1, n) });
			case "pinned": return t("‘{name}’의 고정이 해제됩니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name });
			case "pinned-terminal": return t("‘{name}’의 고정이 해제되고 셸이 종료됩니다.", { name });
			default:
				return n > 0
					? t("‘{name}’의 작업이 중단되고, 예약 작업 {n}개도 닫힌 동안 건너뜁니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name, n })
					: t("‘{name}’의 작업이 중단됩니다. 기록은 남아 /resume 으로 다시 열 수 있습니다.", { name });
		}
	});
	const confirmLabel = $derived(
		shown?.hold === "pinned" || shown?.hold === "scheduled"
			? t("닫기")
			: shown?.hold === "pinned-terminal"
				? t("종료하고 닫기")
				: t("중단하고 닫기"),
	);
</script>

{#if app.sessionCloseConfirm}
	<ConfirmDialog
		id="session-close"
		{icon}
		{title}
		{description}
		oncancel={cancel}
		actions={[
			{ label: t("계속 두기"), variant: "primary", onclick: cancel },
			{ label: confirmLabel, variant: "ghost", destructive: true, onclick: ok },
		]}
	/>
{/if}
