<script lang="ts">
	import type { Snippet } from "svelte";
	import { surfaceIn, surfaceOut } from "../../lib/motion";

	/** The sideways-scrolling row above the composer's text that holds what is attached (image thumbnails, file chips). */
	let { children }: { children: Snippet } = $props();
</script>

<!-- |global: the {#if} that shows this strip is the composer's, not this component's (see tests/motion.test.ts) -->
<div class="strip" in:surfaceIn|global={{ y: 8 }} out:surfaceOut|global={{ y: 8 }}>
	{@render children()}
</div>

<style>
	/* A horizontal scroller clips vertically too: the bottom padding keeps the items' border and focus ring whole */
	.strip {
		display: flex;
		gap: 8px;
		padding: 12px 16px 4px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}
	.strip::-webkit-scrollbar { display: none; }
	/* the composer's text is 16px in from the box, 12px in a narrow pane (@container 420px): the strip follows the same line */
	@container (max-width: 420px) {
		.strip { padding-left: 12px; padding-right: 12px; }
	}
</style>
