<script lang="ts">
  import { extensions } from "../../lib/extensions/host.svelte";
  import ExtensionView from "./ExtensionView.svelte";

  // Navbar items are non-interactive: there is nothing to submit or edit.
  const noop = () => {};
  const none = async () => {};
</script>

{#if extensions.navbar.length}
  <div class="slot">
    {#each extensions.navbar as item (`${item.owner}:${item.id}`)}
      <div class="item" role="group" aria-label={item.label}>
        <ExtensionView node={item.view} namespace={`navbar-${item.owner}-${item.id}`} values={{}} onchange={noop} ondispatch={none} />
      </div>
    {/each}
  </div>
{/if}

<style>
  /* The slot yields to the header title: it is capped and scrolls/clips instead of growing. */
  .slot { display: flex; align-items: center; flex: 0 1 auto; gap: 6px; min-width: 0; max-width: min(40%, 160px); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; padding: 2px 3px; overscroll-behavior-x: contain; }
  .slot::-webkit-scrollbar { display: none; }
  .item { display: flex; align-items: center; flex: none; min-width: 0; max-width: 100%; }
  @media (max-width: 600px) {
    .slot { max-width: min(36%, 132px); gap: 4px; padding: 2px; }
  }
</style>
