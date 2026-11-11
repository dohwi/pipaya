<script lang="ts">
  import { extensions } from "../../lib/extensions/host.svelte";
  import type { UISlot } from "../../lib/extensions/schema";

  /** A place in the app where trusted extension components (`ui-components`) can be mounted. `props` are handed to them as-is. */
  let { slot, props = {}, owners }: { slot: UISlot; props?: Record<string, unknown>; /** Extensions allowed to fill it; the slots of an extension's own page need this (only its owner may fill them) */ owners?: readonly string[] } = $props();
  const items = $derived(extensions.mountsIn(slot, owners));
</script>

{#each items as item (item.key)}
  <!-- A component that throws is reported and dropped; it never takes the rest of the app with it. -->
  <svelte:boundary onerror={(error) => extensions.log(item.owner, `${slot}: ${error instanceof Error ? error.message : String(error)}`)}>
    <item.component {...props} />
    {#snippet failed()}{/snippet}
  </svelte:boundary>
{/each}
