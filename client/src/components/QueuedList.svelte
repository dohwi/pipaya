<script lang="ts">
	import { t } from "../lib/i18n";
	import QueueBadge from "./QueueBadge.svelte";
	import Icon from "./Icon.svelte";
	import { orderQueued } from "../lib/queue";
	import { reflow, rowIn, rowOut } from "../lib/motion";

	type Queued = { mode: "steer" | "follow_up"; text: string };
	/** Messages sent while the agent works and not delivered yet (steer: into this run; queue: after it). */
	let { queued, oncancel }: { queued: Queued[]; oncancel: (q: Queued) => void } = $props();

	// The list scrolls inside a capped height instead of pushing the input down; the grip above resizes the cap.
	const MIN_H = 48;
	const STEP = 24;
	let height = $state(96);
	let drag: { y: number; h: number } | null = null;
	const maxH = () => Math.max(MIN_H, Math.round(window.innerHeight * 0.4));
	const clamp = (h: number) => Math.min(maxH(), Math.max(MIN_H, h));

	function onDown(e: PointerEvent) {
		drag = { y: e.clientY, h: height };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onMove(e: PointerEvent) {
		if (drag) height = clamp(drag.h + (drag.y - e.clientY)); // drag up = taller
	}
	function onUp() {
		drag = null;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
		e.preventDefault();
		height = clamp(height + (e.key === "ArrowUp" ? STEP : -STEP));
	}
</script>

<div class="queued-wrap">
	{#if queued.length > 2}
		<div
			class="grip tap"
			role="slider"
			aria-label={t("대기열 높이 조절")}
			aria-valuenow={height}
			aria-valuemin={MIN_H}
			aria-valuemax={maxH()}
			tabindex="0"
			onpointerdown={onDown}
			onpointermove={onMove}
			onpointerup={onUp}
			onpointercancel={onUp}
			onkeydown={onKey}
		><span></span></div>
	{/if}
	<ul class="queued" style:max-height="{height}px" aria-label={t("전달 대기 중인 메시지")}>
		{#each orderQueued(queued) as q (q.mode + q.n)}
			<li animate:reflow in:rowIn out:rowOut>
				<QueueBadge {q} />
				<span class="qt">{q.text}</span>
				<button type="button" class="qx" onclick={() => oncancel({ mode: q.mode, text: q.text })} aria-label={t("{name} 취소", { name: q.text })} title={t("취소")}><Icon name="x" /></button>
			</li>
		{/each}
	</ul>
</div>

<style>
	.queued-wrap {
		min-height: 0;
	}
	.grip {
		display: grid;
		place-items: center;
		height: 12px;
		cursor: ns-resize;
		touch-action: none;
	}
	.grip span {
		width: 32px;
		height: 4px;
		border-radius: 2px;
		background: var(--text-faint);
		opacity: 0.5;
	}
	.grip:hover span,
	.grip:focus-visible span {
		opacity: 1;
	}
	.queued {
		list-style: none;
		margin: 0;
		padding: 8px 12px 0;
		overflow-y: auto;
		overscroll-behavior: contain;
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
		stroke-width: 2;
	}
	.qt {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
