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
	// How many rows show depends on the room left: a row is 22px + 4px gap, and the last visible one is cut in half
	// (n rows + 4 gap + 11) so it reads as scrollable. visualViewport shrinks when the phone keyboard opens.
	const ROW = 22;
	const GAP = 4;
	const viewH = () => window.visualViewport?.height ?? window.innerHeight;
	let vh = $state(viewH());
	const rows = $derived(vh < 500 ? 1 : vh < 680 ? 2 : 3); // whole rows; a half row follows
	const listH = $derived(rows * ROW + (rows - 1) * GAP + GAP + ROW / 2);
	$effect(() => {
		const sync = () => (vh = viewH());
		window.addEventListener("resize", sync);
		window.visualViewport?.addEventListener("resize", sync);
		return () => {
			window.removeEventListener("resize", sync);
			window.visualViewport?.removeEventListener("resize", sync);
		};
	});
	$effect(() => {
		void listH;
		syncFade();
	});
	let drag: { y: number; top: number; moved: boolean } | null = null;
	// Which edges still hide rows: those edges fade out, so a half-cut row (and its ✕) never reads as a button.
	let fadeTop = $state(false);
	let fadeBottom = $state(false);
	// A slim thumb in the right gutter (outside the ✕ column) shows there is more, also on touch where native bars hide.
	let thumb = $state<{ top: number; height: number } | null>(null);
	function syncFade() {
		if (!ul) return;
		fadeTop = ul.scrollTop > 1;
		fadeBottom = ul.scrollTop + ul.clientHeight < ul.scrollHeight - 1;
		const { scrollTop, clientHeight, scrollHeight } = ul;
		if (scrollHeight <= clientHeight + 1) return void (thumb = null);
		const height = Math.max(16, (clientHeight * clientHeight) / scrollHeight);
		thumb = { top: (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height), height };
	}
	$effect(() => {
		void queued.length;
		void listH;
		syncFade();
	});
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

<div class="queued-wrap">
<div class="scroll">
{#if thumb}<span class="thumb" aria-hidden="true" style:top="{thumb.top}px" style:height="{thumb.height}px"></span>{/if}
<ul class="queued" style:max-height="{listH}px" class:fade-top={fadeTop} class:fade-bottom={fadeBottom} onscroll={syncFade} bind:this={ul} onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} aria-label={t("전달 대기 중인 메시지")}>
	{#each orderQueued(queued) as q (q.mode + q.n)}
		<li animate:reflow in:rowIn out:rowOut>
			<QueueBadge {q} />
			<span class="qt">{q.text}</span>
			<button type="button" class="qx" onclick={() => oncancel({ mode: q.mode, text: q.text })} aria-label={t("{name} 취소", { name: q.text })} title={t("취소")}><Icon name="x" /></button>
		</li>
	{/each}
</ul>
</div>
</div>

<style>
	/* The gap above lives outside the scroller so the first row never touches the box edge, scrolled or not.
	   12px 16px = the textarea's own padding, so badges start on the text line and the ✕ glyph ends on it. */
	.queued-wrap {
		position: relative;
		padding: 12px 16px 0;
	}
	.scroll {
		position: relative;
	}
	/* Track = the scroller; right: -10px puts the 4px thumb mid-gutter of the wrap's 16px side padding. */
	.thumb {
		position: absolute;
		right: -10px;
		width: 4px;
		border-radius: 2px;
		background: var(--text-faint);
		opacity: 0.6;
		pointer-events: none;
	}
	.queued {
		list-style: none;
		margin: 0;
		padding: 0;
		/* max-height comes from the script (1.5, 2.5 or 3.5 rows, by the room left). */
		overflow-y: auto;
		overscroll-behavior: contain;
		cursor: grab;
		user-select: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	/* 16px ramps: the cut row is mostly gone by the edge. Only the edge that hides rows fades. */
	.fade-bottom {
		mask-image: linear-gradient(to bottom, #000 calc(100% - 16px), transparent);
	}
	.fade-top {
		mask-image: linear-gradient(to top, #000 calc(100% - 16px), transparent);
	}
	.fade-top.fade-bottom {
		mask-image: linear-gradient(to bottom, transparent, #000 16px, #000 calc(100% - 16px), transparent);
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
		margin-right: -4px; /* 22px button, 14px glyph: the glyph's right end (not the button) sits on the 16px text line */
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
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	.qt {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
