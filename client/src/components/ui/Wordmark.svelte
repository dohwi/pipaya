<script lang="ts">
	/**
	 * The "pipaya" wordmark: `size` px tall, drawn from the glyph outlines of JetBrains Mono 600 (logo/build_wordmark.py)
	 * in a closed shadow root, so no theme font, colour or extension style can change it (lib/pipaya-logo.ts).
	 */
	import { logo, wordmarkMarkup } from "../../lib/pipaya-logo";
	import { uiEnv } from "../../lib/ui-env.svelte";

	let { size = 14 }: { size?: number } = $props();
</script>

<span data-pipaya-logo {@attach logo((dark) => wordmarkMarkup({ size, dark }), () => uiEnv.dark())}></span>
