<script lang="ts">
  import { t } from "../../lib/i18n";
  import { app } from "../../lib/store.svelte";
  import { closeAnimated } from "../../lib/motion";
  let dialog: HTMLDialogElement;
  /** What the dialog shows while it plays its exit: the request is already cleared by then. */
  let shown = $state<NonNullable<typeof app.extensionApproval> | null>(null);
  let cancelClose = () => {};
  // The dialog follows the request: open when one arrives, play the exit and close when it is resolved
  // (by a button, Esc, or anything else that settles it).
  $effect(() => {
    const request = app.extensionApproval;
    if (request) {
      cancelClose();
      shown = request;
      if (!dialog.open) dialog.showModal();
    } else if (dialog?.open) {
      cancelClose = closeAnimated(dialog);
    }
  });
</script>
<dialog bind:this={dialog} oncancel={(event) => { event.preventDefault(); app.resolveExtension(false); }} onclose={() => { shown = null; app.extensionApproval && app.resolveExtension(false); }} aria-labelledby="extension-approval-title">
  {#if shown}
    <h2 id="extension-approval-title">pipaya · {t("확장 설정 접근 승인")}</h2>
    <p>{t("확장 요청입니다. 승인한 범위만 앱에서 수행합니다.")}</p>
    <pre>{shown.message}</pre>
    <div class="buttons">
      <button onclick={() => app.resolveExtension(false)}>{t("취소")}</button>
      <button class="approve" onclick={() => app.resolveExtension(true)}>{t("승인하고 진행")}</button>
    </div>
  {/if}
</dialog>
<style>
  dialog { width: min(var(--modal-w-l), calc(var(--vw) - var(--modal-gutter))); padding: 24px; border: 1px solid var(--border-strong); border-radius: var(--radius-panel); background: var(--bg-side); box-shadow: var(--shadow); color: var(--text); }
  dialog::backdrop { background: var(--scrim); }
  h2 { margin: 0 0 12px; font-size: var(--fs-xl); }
  p { color: var(--text-dim); font-size: var(--fs-sm); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.6; }
  .buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  button { padding: 9px 14px; border: 1px solid var(--border); border-radius: var(--radius); }
  .approve { background: var(--accent); color: var(--accent-fg); }
</style>
