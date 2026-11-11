<script lang="ts">
  import Button from "../ui/Button.svelte";
  import DialogBody from "../ui/DialogBody.svelte";
  import DialogFooter from "../ui/DialogFooter.svelte";
  import Modal from "../ui/Modal.svelte";
  import { t } from "../../lib/i18n";
  import { app } from "../../lib/store.svelte";

  /**
   * An extension asks to change app settings. Nothing is focused by default, so a stray Enter never approves.
   * The shared Modal gives it the scrim, the layering, Esc / back / scrim
   * dismissal (each settles the request as "no") and the exit motion; the request going away closes it, whoever settled it.
   */
  const deny = () => app.extensionRequests.approve(false);
  /** The last message, so the text stays on screen while the exit plays after the request was settled. */
  let last = $state("");
  $effect(() => {
    if (app.extensionRequests.approval) last = app.extensionRequests.approval.message;
  });
</script>

{#if app.extensionRequests.approval}
  <Modal onclose={deny} title={`pipaya · ${t("확장 설정 접근 승인")}`} width="l" layer={5} portal>
    <DialogBody gap>
      <p class="lead">{t("확장 요청입니다. 승인한 범위만 앱에서 수행합니다.")}</p>
      <pre class="message">{app.extensionRequests.approval?.message ?? last}</pre>
    </DialogBody>
    <DialogFooter rule safe>
      <Button onclick={deny}>{t("취소")}</Button>
      <Button variant="primary" onclick={() => app.extensionRequests.approve(true)}>{t("승인하고 진행")}</Button>
    </DialogFooter>
  </Modal>
{/if}

<style>
  .lead { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); line-height: 20px; }
  .message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 24px; }
</style>
