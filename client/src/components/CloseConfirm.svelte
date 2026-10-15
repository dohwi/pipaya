<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Modal from "./Modal.svelte";

	/** Closing the window while agents work: asks once, through the shared Modal (same scrim, motion and layering). */
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
	<Modal onclose={cancel} dismissible={!stopping} role="alertdialog" labelledby="close-confirm-title" describedby="close-confirm-desc" width="s" layer={4} sheet={false}>
		<div class="cc">
			<h2 id="close-confirm-title">{t("작업을 종료하고 닫을까요?")}</h2>
			<p id="close-confirm-desc">{t("진행 중인 작업 {n}개가 종료되면서 창이 닫힙니다.", { n: (app.closeConfirm ?? last)?.count ?? 0 })}</p>
			<div class="buttons">
				<button type="button" class="btn" onclick={cancel} disabled={stopping}>{t("취소")}</button>
				<!-- svelte-ignore a11y_autofocus -->
				<button type="button" class="btn primary" onclick={ok} disabled={stopping} autofocus>{t("확인")}</button>
			</div>
		</div>
	</Modal>
{/if}

<style>
	.cc {
		padding: 24px;
	}
	h2 {
		margin: 0 0 12px;
		font-size: var(--fs-xl);
	}
	p {
		color: var(--text-dim);
		font-size: var(--fs-sm);
		line-height: 1.6;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 20px;
	}
</style>
