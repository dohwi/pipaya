<script lang="ts">
	import { t } from "../lib/i18n";
	import QueueBadge from "./QueueBadge.svelte";
	import Icon from "./Icon.svelte";
	import { orderQueued } from "../lib/queue";
	import { reflow, rowIn, rowOut } from "../lib/motion";

	type Queued = { mode: "steer" | "follow_up"; text: string };
	/** Messages sent while the agent works and not delivered yet (steer: into this run; queue: after it). */
	let { queued, oncancel }: { queued: Queued[]; oncancel: (q: Queued) => void } = $props();
</script>

<ul class="queued" aria-label={t("전달 대기 중인 메시지")}>
	{#each orderQueued(queued) as q (q.mode + q.n)}
		<li animate:reflow in:rowIn out:rowOut>
			<QueueBadge {q} />
			<span class="qt">{q.text}</span>
			<button type="button" class="qx" onclick={() => oncancel({ mode: q.mode, text: q.text })} aria-label={t("{name} 취소", { name: q.text })} title={t("취소")}><Icon name="x" /></button>
		</li>
	{/each}
</ul>

<style>
	.queued {
		list-style: none;
		margin: 0;
		padding: 8px 14px 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.queued li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.qx {
		flex: none;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-left: auto;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	.qx:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.qx :global(svg) {
		width: 13px;
		height: 13px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
	}
	.qt {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
