<script lang="ts">
  import Button from "../Button.svelte";
  import DialogBody from "../DialogBody.svelte";
  import DialogFooter from "../DialogFooter.svelte";
  import Modal from "../Modal.svelte";
  import { t } from "../../lib/i18n";
  import { app } from "../../lib/store.svelte";

  /**
   * `ui.confirm` / `ui.select` / `ui.input` from an extension. The shared Modal gives it the scrim, the layering, Esc / back /
   * scrim dismissal (each cancels) and the exit motion; the request going away closes it, whoever settled it.
   */
  type Pending = NonNullable<typeof app.extensionDialog>;
  /** The last request, so the text stays on screen while the exit plays after the request was settled. */
  let last = $state<Pending | null>(null);
  let typed = $state("");
  let picked = $state("");

  $effect(() => {
    const pending = app.extensionDialog;
    if (!pending || pending === last) return;
    last = pending;
    typed = pending.request.kind === "input" ? (pending.request.value ?? "") : "";
    picked = pending.request.kind === "select" ? (pending.request.options[0]?.value ?? "") : "";
  });

  const cancel = () => app.resolveExtensionDialog(app.extensionDialog?.request.kind === "confirm" ? false : null);
  function ok() {
    const r = app.extensionDialog?.request;
    if (!r) return;
    app.resolveExtensionDialog(r.kind === "confirm" ? true : r.kind === "select" ? picked : typed);
  }
  function enter(event: KeyboardEvent) {
    const r = app.extensionDialog?.request;
    if (event.key === "Enter" && !event.isComposing && (r?.kind !== "input" || !r.multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ok();
    }
  }
  const autofocus = (node: HTMLElement) => { queueMicrotask(() => node.focus()); };
  const focusFirst = (node: HTMLElement, first: boolean) => { if (first) autofocus(node); };
</script>

{#if app.extensionDialog}
  {@const r = (app.extensionDialog ?? last)!.request}
  <Modal onclose={cancel} title={r.title} sub={r.ownerName} width="l" layer={5} portal>
    <DialogBody gap>
      {#if r.message}<pre class="message">{r.message}</pre>{/if}
      {#if r.kind === "select"}
        <div class="options" role="radiogroup" aria-label={r.title}>
          {#each r.options as option, i (option.value)}
            <label class:on={picked === option.value}>
              <input type="radio" name="extension-dialog" value={option.value} bind:group={picked} onkeydown={enter} use:focusFirst={i === 0} />
              <span class="label">{option.label}</span>
              {#if option.description}<span class="desc">{option.description}</span>{/if}
            </label>
          {/each}
        </div>
      {:else if r.kind === "input"}
        {#if r.multiline}
          <textarea class="field area" bind:value={typed} placeholder={r.placeholder} aria-label={r.title} rows="5" onkeydown={enter} use:autofocus></textarea>
        {:else}
          <input class="field" type="text" bind:value={typed} placeholder={r.placeholder} aria-label={r.title} onkeydown={enter} use:autofocus />
        {/if}
      {/if}
    </DialogBody>
    <DialogFooter rule safe>
      <Button onclick={cancel}>{t("취소")}</Button>
      <Button variant="primary" onclick={ok}>{r.kind === "confirm" && r.confirmLabel ? r.confirmLabel : t("확인")}</Button>
    </DialogFooter>
  </Modal>
{/if}

<style>
  .message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 24px; color: var(--text-dim); font-size: var(--fs-sm); }
  .area { height: auto; padding: 8px 12px; resize: vertical; line-height: 24px; }
  .options { display: flex; flex-direction: column; gap: 4px; max-height: min(50dvh, 360px); overflow-y: auto; }
  .options label { display: grid; grid-template-columns: 16px 1fr; gap: 0 8px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
  .options label.on { border-color: var(--accent); background: var(--accent-soft); }
  .options input { grid-row: span 2; align-self: start; margin: 4px 0 0; width: 16px; height: 16px; } /* centred on the label's first 24px line */
  .options .label { line-height: 24px; }
  .desc { grid-column: 2; color: var(--text-dim); font-size: var(--fs-xs); line-height: 16px; }
</style>
