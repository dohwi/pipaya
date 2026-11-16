<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The wide part of a sidebar row that opens it. While the row is renamed it holds the rename field, and a button cannot
	 * hold an input, so it is a plain box then (nothing to click, nothing announced as a button). The look is the sidebar's
	 * `.open` / `.wide` rules either way.
	 * `onintent`: the row is about to be opened (the pointer rests on it, or is pressed), so what it shows can be read ahead.
	 */
	let { renaming, onopen, onintent, title, children }: { renaming: boolean; onopen: () => void; onintent?: () => void; title: string; children: Snippet } = $props();

	/** A pointer passing over the list on its way elsewhere is not an intent: only one that rests this long. */
	const REST_MS = 80;
	let rest: ReturnType<typeof setTimeout> | undefined;
	const enter = (e: PointerEvent) => {
		if (!onintent || e.pointerType !== "mouse") return;
		clearTimeout(rest);
		rest = setTimeout(() => onintent?.(), REST_MS);
	};
	const leave = () => clearTimeout(rest);
	// Not on touch: a finger that lands on a row is as likely to scroll the list as to open it.
	const press = (e: PointerEvent) => {
		clearTimeout(rest);
		if (e.pointerType !== "touch") onintent?.();
	};
	$effect(() => () => clearTimeout(rest));
</script>

{#if renaming}
	<div class="open wide" {title}>{@render children()}</div>
{:else}
	<button class="open wide" onclick={onopen} onpointerenter={enter} onpointerleave={leave} onpointerdown={press} {title}>{@render children()}</button>
{/if}
