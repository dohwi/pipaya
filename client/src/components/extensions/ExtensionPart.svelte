<script lang="ts">
  import type { Snippet } from "svelte";
  import { extensions } from "../../lib/extensions/host.svelte";
  import type { UIPart } from "../../lib/extensions/schema";

  /**
   * A built-in piece an extension may replace (`replaces` in a `ui-components` package). The extension's component gets
   * `props` plus `fallback`, a snippet that draws the original, so it can wrap or restyle instead of rebuilding.
   * If the replacement throws, the original is drawn.
   */
  let { part, props = {}, children }: { part: UIPart; props?: Record<string, unknown>; children: Snippet } = $props();
  const swap = $derived(extensions.replacementFor(part));
</script>

{#if swap}
  <svelte:boundary onerror={(error) => extensions.log(swap.owner, `${part}: ${error instanceof Error ? error.message : String(error)}`)}>
    <swap.component {...props} fallback={children} />
    {#snippet failed()}{@render children()}{/snippet}
  </svelte:boundary>
{:else}
  {@render children()}
{/if}
