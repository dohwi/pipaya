<script lang="ts">
	import Icon from "./Icon.svelte";
	import { badgeStyle, type ToolIcon, type ToolKind } from "../lib/tools";

	/** The one tool chip: the work box line, the cards in its detail dialog. The look lives in app.css (.tbadge). */
	let { kind, icon, label = "", shimmer = false }: { kind: ToolKind; icon: ToolIcon; label?: string; shimmer?: boolean } = $props();
</script>

<span class="tbadge {kind}" class:bare={!label} style={badgeStyle(kind)}>
	<Icon name={icon} />
	{#if label}<span class="tb-label" class:shimmer>{label}</span>{/if}
</span>
