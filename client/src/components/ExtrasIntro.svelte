<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The two lines at the top of every list dialog that tell what the thing is for, in the same words and the same place:
	 * `what` (one sentence: what it is) and an optional `how` (how it is used or what to watch for). The text sits on the
	 * dialog surface, not in a box, so it reads as the dialog's own subtitle. It has no margin of its own: the container's
	 * `gap` (DialogBody `gap`, `--dlg-gap`) spaces it from the groups, the same in every dialog.
	 */
	let { what, how, children }: { what: string; how?: string; children?: Snippet } = $props();
</script>

<div class="intro">
	<p class="what">{what}</p>
	{#if how}<p class="how">{how}</p>{/if}
	{@render children?.()}
</div>

<style>
	.intro { display: flex; flex-direction: column; gap: 4px; }
	.what { margin: 0; font-size: var(--fs-sm); line-height: 20px; color: var(--text); }
	.how { margin: 0; font-size: var(--fs-xs); line-height: 18px; color: var(--text-dim); }
</style>
