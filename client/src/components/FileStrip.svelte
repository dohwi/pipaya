<script lang="ts">
	import { chipIn, chipOut, reflow, surfaceIn, surfaceOut } from "../lib/motion";
	import type { FileDraft } from "../lib/files";
	import FileChip from "./FileChip.svelte";

	/** Non-image files waiting in the composer, one removable chip each. */
	let { files, onremove }: { files: FileDraft[]; onremove: (id: string) => void } = $props();
</script>

<!-- |global: the {#if} that shows this strip is the composer's, not this component's (see tests/motion.test.ts) -->
<div class="files" in:surfaceIn|global={{ y: 8 }} out:surfaceOut|global={{ y: 8 }}>
	{#each files as f (f.id)}
		<div class="fchip-slot" animate:reflow in:chipIn out:chipOut><FileChip name={f.name} size={f.size} preview={f.preview} onremove={() => onremove(f.id)} /></div>
	{/each}
</div>

<style>
	/* bottom padding: the scroller clips vertically too, and the chips' border and focus ring end there */
	.files {
		display: flex;
		gap: 10px;
		padding: 12px 14px 4px;
		overflow-x: auto;
		scrollbar-width: thin;
	}
</style>
