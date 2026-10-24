<script lang="ts">
	import Badge from "./Badge.svelte";
	import Icon from "./Icon.svelte";
	import { queuedLabel, queuedTone, type QueuedView } from "../lib/queue";

	/** Icon + order number only; the full mode name stays in the tooltip and the accessible label. */
	let { q }: { q: QueuedView } = $props();
	const label = $derived(queuedLabel(q));
</script>

<span class="qb" title={label} aria-label={label} role="img">
	<Badge variant="soft" size="sm" mono square tone={queuedTone(q.mode)}>
		<span class="in"><Icon name={q.mode === "steer" ? "bolt" : "list"} /><span class="n">{q.n}</span></span>
	</Badge>
</span>

<style>
	.qb {
		display: inline-flex;
		flex: none;
	}
	.in {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 0 1px;
	}
	.in :global(svg) {

		width: 11px;

		height: 11px;

		stroke-width: 2.2;

	}
	.n {
		font-variant-numeric: tabular-nums;
	}
</style>
