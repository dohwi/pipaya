<script lang="ts">
	import type { IconSpec } from "../../lib/extensions/ui";
	type Size = "small" | "medium" | "large";
	let { icon, size = "medium", label }: { icon: IconSpec; size?: Size; label?: string } = $props();
</script>

<!-- Only validated viewBox/path data reaches the DOM; there is no raw SVG, URL, gradient or CSS. -->
<svg
	class="icon size-{size}"
	viewBox={icon.viewBox}
	focusable="false"
	role={label ? "img" : undefined}
	aria-label={label || undefined}
	aria-hidden={label ? undefined : "true"}
>
	{#each icon.paths as path}
		<path d={path.d} fill={path.fill ?? "currentColor"} fill-rule={path.fillRule ?? "nonzero"} />
	{/each}
</svg>

<style>
	.icon { flex: none; display: inline-block; max-width: 100%; overflow: hidden; color: var(--text-dim); vertical-align: middle; }
	.size-small { width: 14px; height: 14px; }
	.size-medium { width: 20px; height: 20px; }
	.size-large { width: 32px; height: 32px; }
</style>
