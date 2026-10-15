<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { closeAnimated } from "../lib/motion";
	let dialog: HTMLDialogElement;
	let shown = $state<NonNullable<typeof app.closeConfirm> | null>(null);
	let stopping = $state(false);
	let cancelClose = () => {};
	$effect(() => {
		const req = app.closeConfirm;
		if (req) {
			cancelClose();
			shown = req;
			stopping = false;
			if (!dialog.open) dialog.showModal();
		} else if (dialog?.open) {
			cancelClose = closeAnimated(dialog);
		}
	});
	function ok() {
		if (!shown || stopping) return;
		stopping = true;
		shown.confirm();
	}
</script>

<dialog bind:this={dialog} oncancel={(e) => { e.preventDefault(); if (!stopping) app.closeConfirm?.cancel(); }} onclose={() => { shown = null; app.closeConfirm?.cancel(); }} aria-labelledby="close-confirm-title">
	{#if shown}
		<h2 id="close-confirm-title">{t("작업을 종료하고 닫을까요?")}</h2>
		<p>{t("진행 중인 작업 {n}개가 종료되면서 창이 닫힙니다.", { n: shown.count })}</p>
		<div class="buttons">
			<button onclick={() => shown?.cancel()} disabled={stopping}>{t("취소")}</button>
			<!-- svelte-ignore a11y_autofocus -->
			<button class="approve" onclick={ok} disabled={stopping} autofocus>{t("확인")}</button>
		</div>
	{/if}
</dialog>

<style>
	dialog { width: min(var(--modal-w-s), calc(100vw - var(--modal-gutter))); padding: 24px; border: 1px solid var(--border-strong); border-radius: var(--radius-panel); background: var(--bg-side); box-shadow: var(--shadow); color: var(--text); }
	dialog::backdrop { background: var(--scrim); }
	h2 { margin: 0 0 12px; font-size: var(--fs-xl); }
	p { color: var(--text-dim); font-size: var(--fs-sm); line-height: 1.6; }
	.buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
	button { padding: 9px 14px; border: 1px solid var(--border); border-radius: var(--radius); }
	button:disabled { opacity: 0.6; }
	.approve { background: var(--accent); color: var(--accent-fg); }
</style>
