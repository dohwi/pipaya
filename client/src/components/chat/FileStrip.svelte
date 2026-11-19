<script lang="ts">
	import { chipIn, chipOut, reflow } from "../../lib/motion";
	import type { FileDraft } from "../../lib/files";
	import ComposerStrip from "./ComposerStrip.svelte";
	import FileChip from "./FileChip.svelte";

	/** Non-image files waiting in the composer, one removable chip each. */
	let { files, onremove }: { files: FileDraft[]; onremove: (id: string) => void } = $props();
</script>

<ComposerStrip>
	{#each files as f (f.id)}
		<div class="fchip-slot" animate:reflow in:chipIn out:chipOut><FileChip name={f.name} size={f.size} preview={f.preview} onremove={() => onremove(f.id)} /></div>
	{/each}
</ComposerStrip>

