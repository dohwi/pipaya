<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import { QUEUE_BADGE_W, queuedLabel, queuedTone, type QueuedView } from "../../lib/queue";

	/** Icon + order number only; the full mode name stays in the tooltip and the accessible label. */
	let { q }: { q: QueuedView } = $props();
	const label = $derived(queuedLabel(q));
</script>

<span class="qb" title={label} aria-label={label} role="img">
	<Badge variant="soft" size="sm" mono tone={queuedTone(q.mode)} minWidth={QUEUE_BADGE_W}>
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
		gap: 4px;
		padding: 0 1px;
	}
	/* 12px like the sender's chat glyph beside it. The badge's 1px bottom padding lifts its text, but it put an
	   icon (odd 11px, then even 12px) 0.5-1px high of the pill's centre; -1px gives that padding back to the icon
	   only, so it sits 3px from both pill edges (measured 1x-4x: within 0.33px of the row's centre). */
	.in :global(svg) {
		width: 12px;
		height: 12px;
		margin-bottom: -1px;
		stroke-width: 2.2;
	}
	.n {
		font-variant-numeric: tabular-nums;
	}
</style>
