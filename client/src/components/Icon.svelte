<script lang="ts" module>
	export type { IconName } from "../lib/icons";
</script>

<script lang="ts">
	import { ICON_PATHS, type IconName as Name } from "../lib/icons";

	let { name }: { name: Name } = $props();
</script>

<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>

<style>
	/* Line-icon defaults at zero specificity (:where), so any rule in the parent (a size, a fill, a thinner stroke) wins
	   without !important. New code needs nothing; existing per-component svg rules keep working unchanged. */
	:where(.ic) {
		width: 1em;
		height: 1em;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
