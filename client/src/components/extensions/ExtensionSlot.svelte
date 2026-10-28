<script lang="ts">
  import { extensions } from "../../lib/extensions/host.svelte";
  import ExtensionView from "./ExtensionView.svelte";

  let { slot }: { slot: "header" | "footer" } = $props();
  // Slot items are display only, like navbar items: nothing to submit or edit.
  const noop = () => {};
  const none = async () => {};
  const items = $derived(extensions.slots.filter((s) => s.slot === slot && extensions.installed.some((e) => e.package.manifest.id === s.owner && e.state === "active")));
</script>

{#if items.length}
  <div class="slot {slot}">
    {#each items as item (`${item.owner}:${item.id}`)}
      <div class="item" role="group" aria-label={item.label}>
        <ExtensionView node={item.view} namespace={`slot-${slot}-${item.owner}-${item.id}`} values={{}} onchange={noop} ondispatch={none} />
      </div>
    {/each}
  </div>
{/if}

<style>
  .slot { display: flex; flex-direction: column; gap: 4px; padding: 4px 16px; min-width: 0; max-width: calc(var(--content-w) + 32px); width: 100%; margin: 0 auto; box-sizing: border-box; }
  .slot.header { border-bottom: 1px solid var(--border); }
  .item { min-width: 0; overflow-wrap: anywhere; }
</style>
