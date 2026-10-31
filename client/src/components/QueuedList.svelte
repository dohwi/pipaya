<script lang="ts">
	import { t } from "../lib/i18n";
	import QueueBadge from "./QueueBadge.svelte";
	import Icon from "./Icon.svelte";
	import { orderQueued } from "../lib/queue";
	import { reflow, rowIn, rowOut } from "../lib/motion";

	type Queued = { mode: "steer" | "follow_up"; text: string };
	/** Messages sent while the agent works and not delivered yet (steer: into this run; queue: after it). */
	let { queued, oncancel }: { queued: Queued[]; oncancel: (q: Queued) => void } = $props();

	// The list has a fixed max height and scrolls inside it, so a long queue never pushes the input down.
	// Touch scrolls by swipe; a mouse can drag the list itself (a small move first, so the cancel buttons still click).
	let ul = $state<HTMLUListElement>();
	let drag: { y: number; top: number; moved: boolean } | null = null;
	const THRESHOLD = 4; // px of travel before a press counts as a drag

	function onDown(e: PointerEvent) {
		if (e.pointerType !== "mouse" || e.button !== 0 || !ul || ul.scrollHeight <= ul.clientHeight) return;
		drag = { y: e.clientY, top: ul.scrollTop, moved: false };
	}
	function onMove(e: PointerEvent) {
		if (!drag || !ul) return;
		const dy = e.clientY - drag.y;
		if (!drag.moved) {
			if (Math.abs(dy) < THRESHOLD) return;
			drag.moved = true;
			ul.setPointerCapture(e.pointerId);
		}
		ul.scrollTop = drag.top - dy;
	}
	function onUp(e: PointerEvent) {
		if (drag?.moved && ul?.hasPointerCapture(e.pointerId)) ul.releasePointerCapture(e.pointerId);
		drag = null;
	}
</script>

<ul class="queued" bind:this={ul} onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} aria-label={t("전달 대기 중인 메시지")}>
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
		padding: 8px 12px 0;
		/* Two rows (22px + 4px gap) under 8px of padding, plus a peek of the third so it reads as scrollable.
		   On a short window (phone with the keyboard open) one row and a peek. */
		max-height: 72px;
		overflow-y: auto;
		overscroll-behavior: contain;
		cursor: grab;
		user-select: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	@media (max-height: 600px) {
		.queued {
			max-height: 46px;
		}
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
	.qx {
		cursor: pointer;
	}
	.qx:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.qx :global(svg) {
		width: 13px;
		height: 13px;
		stroke-width: 2;
	}
	.qt {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
