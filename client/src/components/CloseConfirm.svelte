<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	/** Closing the window while agents work: asks once, through the shared ConfirmDialog (same scrim, motion and layering). */
	let stopping = $state(false);
	// keep the last request on screen while the exit plays, so the text does not blank out
	let last = $state<NonNullable<typeof app.closeConfirm> | null>(null);
	$effect(() => {
		if (app.closeConfirm) {
			last = app.closeConfirm;
			stopping = false;
		}
	});
	function ok() {
		if (!app.closeConfirm || stopping) return;
		stopping = true;
		app.closeConfirm.confirm();
	}
	const cancel = () => !stopping && app.closeConfirm?.cancel();
</script>

{#if app.closeConfirm}
	<ConfirmDialog
		id="close-confirm"
		portal={false}
		sheet={false}
		busy={stopping}
		title={t("작업을 종료하고 닫을까요?")}
		description={t("진행 중인 작업 {n}개가 종료되면서 창이 닫힙니다.", { n: (app.closeConfirm ?? last)?.count ?? 0 })}
		oncancel={cancel}
		actions={[
			{ label: t("취소"), onclick: cancel },
			{ label: t("종료하고 닫기"), variant: "primary", onclick: ok },
		]}
	/>
{/if}
