<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The wide part of a sidebar row that opens it. While the row is renamed it holds the rename field, and a button cannot
	 * hold an input, so it is a plain box then (nothing to click, nothing announced as a button). The look is the sidebar's
	 * `.open` / `.wide` rules either way.
	 */
	let { renaming, onopen, title, children }: { renaming: boolean; onopen: () => void; title: string; children: Snippet } = $props();
</script>

{#if renaming}
	<div class="open wide" {title}>{@render children()}</div>
{:else}
	<button class="open wide" onclick={onopen} {title}>{@render children()}</button>
{/if}
