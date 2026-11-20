<script lang="ts">
	/**
	 * pipaya mark for the sidebar / rail / empty states: the papaya tree with a square crown (5 fronds drooping to the sides,
	 * 2 big fruit) on a short, thick trunk, so it fills a 1:1 box and stays readable when small. No eyes, no animation.
	 * Geometry matches logo/build_mark.py (the app icon uses the same crown).
	 *  - `tone`: `color` two-tone, `solid` one brand colour, `watermark` the faint mark of the empty screens (all three in
	 *    the brand's colours, which no theme changes), `current` the colour of where it sits, like an icon (default).
	 * Drawn in a closed shadow root so no extension can change it (lib/pipaya-logo.ts).
	 */
	import { logo, markMarkup, type MarkTone } from "../../lib/pipaya-logo";
	import { app } from "../../lib/store.svelte";

	let { tone = "current", size = 22 }: { tone?: MarkTone; size?: number } = $props();
</script>

<!-- a brand placement (not `current`, which is an icon) is marked so extension styles keep off it (extensions/style.ts) -->
<span data-pipaya-logo={tone === "current" ? undefined : ""} {@attach logo((dark) => markMarkup({ size, tone, dark }), () => app.prefs.resolvedDark)}></span>
