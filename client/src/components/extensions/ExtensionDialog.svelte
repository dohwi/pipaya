<script lang="ts">
  import { t } from "../../lib/i18n";
  import { app } from "../../lib/store.svelte";
  import { closeAnimated } from "../../lib/motion";
  import { backLayer } from "../../lib/dialog";
  let dialog: HTMLDialogElement;
  type Pending = NonNullable<typeof app.extensionDialog>;
  /** What the dialog shows while it plays its exit: the request is already cleared by then. */
  let shown = $state<Pending | null>(null);
  let typed = $state("");
  let picked = $state("");
  let cancelClose = () => {};

  $effect(() => {
    const pending = app.extensionDialog;
    if (pending) {
      cancelClose();
      shown = pending;
      typed = pending.request.kind === "input" ? (pending.request.value ?? "") : "";
      picked = pending.request.kind === "select" ? (pending.request.options[0]?.value ?? "") : "";
      if (!dialog.open) dialog.showModal();
    } else if (dialog?.open) {
      cancelClose = closeAnimated(dialog);
    }
  });

  const cancel = () => app.resolveExtensionDialog(shown?.request.kind === "confirm" ? false : null);
  function ok() {
    const r = shown?.request;
    if (!r) return;
    app.resolveExtensionDialog(r.kind === "confirm" ? true : r.kind === "select" ? picked : typed);
  }
  function enter(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.isComposing && (shown?.request.kind !== "input" || !shown.request.multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ok();
    }
  }
  const autofocus = (node: HTMLElement) => { queueMicrotask(() => node.focus()); };
  const focusFirst = (node: HTMLElement, first: boolean) => { if (first) autofocus(node); };
  // Back button / swipe settles the request like Esc does.
  $effect(() => {
    if (!app.extensionDialog) return;
    return backLayer({ onclose: () => cancel() });
  });
</script>

<dialog bind:this={dialog} oncancel={(event) => { event.preventDefault(); cancel(); }} onclose={() => { shown = null; if (app.extensionDialog) cancel(); }} aria-labelledby="extension-dialog-title">
  {#if shown}
    {@const r = shown.request}
    <h2 id="extension-dialog-title">{r.title}</h2>
    {#if r.ownerName}<p class="owner">{r.ownerName}</p>{/if}
    {#if r.message}<pre>{r.message}</pre>{/if}
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
        <!-- svelte-ignore a11y_autofocus -->
        <textarea bind:value={typed} placeholder={r.placeholder} rows="5" onkeydown={enter} use:autofocus></textarea>
      {:else}
        <input type="text" bind:value={typed} placeholder={r.placeholder} onkeydown={enter} use:autofocus />
      {/if}
    {/if}
    <div class="buttons">
      <button onclick={cancel}>{t("취소")}</button>
      <button class="approve" onclick={ok}>{r.kind === "confirm" && r.confirmLabel ? r.confirmLabel : t("확인")}</button>
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(var(--modal-w-l), calc(var(--vw) - var(--modal-gutter))); padding: 24px; border: 1px solid var(--border-strong); border-radius: var(--radius-panel); background: var(--bg-side); box-shadow: var(--shadow); color: var(--text); }
  dialog::backdrop { background: var(--scrim); }
  h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
  .owner { margin: 0 0 12px; color: var(--text-faint); font-size: var(--fs-xs); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.6; color: var(--text-dim); font-size: var(--fs-sm); margin: 0 0 12px; }
  input[type="text"], textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--text); font: inherit; resize: vertical; }
  .options { display: flex; flex-direction: column; gap: 6px; max-height: min(50dvh, 360px); overflow-y: auto; }
  .options label { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
  .options label.on { border-color: var(--accent); background: var(--accent-soft); }
  .options input { grid-row: span 2; align-self: center; }
  .desc { grid-column: 2; color: var(--text-dim); font-size: var(--fs-xs); }
  .buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  button { padding: 9px 14px; border: 1px solid var(--border); border-radius: var(--radius); }
  .approve { background: var(--accent); color: var(--accent-fg); }
</style>
