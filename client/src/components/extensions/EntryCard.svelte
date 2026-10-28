<script lang="ts">
  import { extensions } from "../../lib/extensions/host.svelte";
  import type { EntryItem } from "../../lib/types";
  import type { UINode } from "../../lib/extensions/ui";
  import ExtensionView from "./ExtensionView.svelte";

  let { item }: { item: EntryItem } = $props();

  // A record a server extension stored on the conversation, drawn by a client extension's renderer. The renderer returns
  // validated read-only data; if it fails or answers nothing, no card is shown (the record itself is never lost).
  const renderer = $derived(extensions.messageRendererFor(item.entryType));
  let view = $state<UINode | null>(null);
  $effect(() => {
    const r = renderer;
    if (!r) { view = null; return; }
    let live = true;
    r.render({ id: item.id, extension: item.extension, type: item.entryType, data: item.data, createdAt: item.ts })
      .then((v) => { if (live) view = v; })
      .catch(() => { if (live) view = null; });
    return () => { live = false; };
  });
  const noop = () => {};
  const none = async () => {};
</script>

{#if view && renderer}
  <div class="entry" role="group" aria-label={renderer.owner}>
    <ExtensionView node={view} namespace={`entry-${renderer.owner}-${item.id}`} values={{}} onchange={noop} ondispatch={none} />
  </div>
{/if}

<style>
  .entry { margin: 8px 0; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev); min-width: 0; overflow-wrap: anywhere; }
</style>
