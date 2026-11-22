<script lang="ts">
	import { t } from "../../lib/i18n";
	import QueueBadge from "./QueueBadge.svelte";
	import QueueText from "./QueueText.svelte";
	import ScheduleRow from "./ScheduleRow.svelte";
	import type { Schedule } from "../../lib/types";
	import Icon from "../ui/Icon.svelte";
	import { orderQueued, queuedLabel, queuedShown, queuedTone } from "../../lib/queue";
	import { reflow, rowIn, rowOut } from "../../lib/motion";
	import { released } from "../../lib/pointer";

	type Queued = { mode: "steer" | "follow_up"; text: string; deferred?: boolean };
	/**
	 * Messages sent while the agent works and not delivered yet (steer: into this run; queue: after it), then the
	 * conversation's scheduled tasks (soonest first, paused ones last): one list, so the input has one queue above it.
	 * Tasks come last: a waiting message goes in with the next turn, a task only at its time. `scheduleOf`: the server and
	 * session the tasks belong to (needed to pause, resume or delete them).
	 */
	let {
		queued,
		oncancel,
		onopen,
		schedules = [],
		scheduleOf = null,
	}: {
		queued: Queued[];
		oncancel: (q: Queued) => void;
		onopen: (q: Queued) => void;
		schedules?: Schedule[];
		scheduleOf?: { serverId: string; sessionId: string } | null;
	} = $props();
	const tasks = $derived(scheduleOf ? schedules : []);
	const total = $derived(queued.length + tasks.length);

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
	const baseH = $derived(rows * ROW + (rows - 1) * GAP + GAP + ROW / 2);
	// The grip on top pulls the list taller (never shorter than the default), up to every row or 40% of the pane the
	// composer sits in: a split pane or a short window keeps its header, some conversation and the input in view.
	let wrap = $state<HTMLDivElement>();
	let paneH = $state(0);
	$effect(() => {
		const pane = wrap?.closest<HTMLElement>('[data-part="pane"]');
		if (!pane) return;
		const ro = new ResizeObserver(() => (paneH = pane.clientHeight));
		ro.observe(pane);
		return () => ro.disconnect();
	});
	const contentH = $derived(total * ROW + Math.max(0, total - 1) * GAP);
	const maxH = $derived(Math.max(baseH, Math.min(contentH, Math.round((paneH || vh) * 0.4))));
	const canGrow = $derived(contentH > baseH);
	let userH = $state<number | null>(null);
	// Once the queue fits again (rows sent or cancelled) the grip goes away and the pulled height is forgotten,
	// so the next long queue starts at the default size.
	$effect(() => {
		if (!canGrow) userH = null;
	});
	const listH = $derived(userH === null ? baseH : Math.min(maxH, Math.max(baseH, userH)));
	let resize: { y: number; h: number } | null = null;
	function onGripDown(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		resize = { y: e.clientY, h: listH };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	// A press on the grip keeps the focus where it was: the draft stays focused and a phone keyboard stays open.
	// (The grip is still reachable with Tab for the arrow keys.)
	const keepFocus = (e: MouseEvent) => e.preventDefault();
	function onGripMove(e: PointerEvent) {
		if (!resize) return;
		// The composer is anchored at the bottom, so pulling up (smaller clientY) makes the list taller.
		const h = Math.min(maxH, Math.max(baseH, resize.h + resize.y - e.clientY));
		userH = h <= baseH ? null : h;
	}
	function onGripUp(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
		resize = null;
	}
	// Window splitter keys: ↑/↓ one row, Home back to the default, End to the most it can show.
	function onGripKey(e: KeyboardEvent) {
		const row = ROW + GAP;
		const h = { ArrowUp: listH + row, ArrowDown: listH - row, Home: baseH, End: maxH }[e.key];
		if (h === undefined) return;
		e.preventDefault();
		const c = Math.min(maxH, Math.max(baseH, h));
		userH = c <= baseH ? null : c;
	}
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
	// A press that dragged the list is not also a click that opens the row under the pointer.
	let dragged = false;
	// Which edges still hide rows: those edges fade out, so a half-cut row (and its ✕) never reads as a button.
	let fadeTop = $state(false);
	let fadeBottom = $state(false);
	// A slim thumb in the right gutter (outside the ✕ column) shows there is more, also on touch where native bars hide.
	let thumb = $state<{ top: number; height: number } | null>(null);
	// Per-mode totals for the summary line shown while the list scrolls.
	const steerN = $derived(queued.filter((q) => q.mode === "steer").length);
	const followN = $derived(queued.length - steerN);
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
		void total;
		void listH;
		syncFade();
	});
	const THRESHOLD = 4; // px of travel before a press counts as a drag

	function onDown(e: PointerEvent) {
		if (e.pointerType !== "mouse" || e.button !== 0 || !ul || ul.scrollHeight <= ul.clientHeight) return;
		drag = { y: e.clientY, top: ul.scrollTop, moved: false };
		dragged = false;
	}
	function onMove(e: PointerEvent) {
		if (!drag || !ul) return;
		if (released(e)) return onUp(e);
		const dy = e.clientY - drag.y;
		if (!drag.moved) {
			if (Math.abs(dy) < THRESHOLD) return;
			drag.moved = true;
			dragged = true;
			ul.setPointerCapture(e.pointerId);
		}
		ul.scrollTop = drag.top - dy;
	}
	function onUp(e: PointerEvent) {
		if (drag?.moved && ul?.hasPointerCapture(e.pointerId)) ul.releasePointerCapture(e.pointerId);
		drag = null;
	}
</script>

<div class="queued-wrap" bind:this={wrap}>
{#if canGrow}
	<!-- A window splitter (WAI-ARIA): focusable, with value attributes; ↑/↓, Home and End resize like the drag. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div class="grip" role="separator" aria-orientation="horizontal" tabindex="0" aria-label={t("대기열 높이 조절")} aria-valuemin={baseH} aria-valuemax={maxH} aria-valuenow={listH} title={t("끌어서 높이 조절 · 더블 클릭으로 원래 크기")}
		onpointerdown={onGripDown} onmousedown={keepFocus} onpointermove={onGripMove} onpointerup={onGripUp} onpointercancel={onGripUp} onlostpointercapture={() => (resize = null)} ondblclick={() => (userH = null)} onkeydown={onGripKey}></div>
{/if}
{#if thumb || canGrow}
	<p class="count" role="status" aria-label={t("{n}개 대기 중", { n: total })}>
		{#if steerN}<span class="c {queuedTone("steer")}" title={queuedLabel({ mode: "steer", text: "", n: steerN })}><Icon name="bolt" />{steerN}</span>{/if}
		{#if followN}<span class="c {queuedTone("follow_up")}" title={queuedLabel({ mode: "follow_up", text: "", n: followN })}><Icon name="list" />{followN}</span>{/if}
		{#if tasks.length}<span class="c" title={t("예약 {n}개", { n: tasks.length })}><Icon name="clock" />{tasks.length}</span>{/if}
	</p>
{/if}
<div class="scroll">
{#if thumb}<span class="thumb" aria-hidden="true" style:top="{thumb.top}px" style:height="{thumb.height}px"></span>{/if}
<ul class="queued" style:max-height="{listH}px" class:fade-top={fadeTop} class:fade-bottom={fadeBottom} onscroll={syncFade} bind:this={ul} onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} aria-label={tasks.length ? t("대기 중인 메시지와 예약 작업") : t("전달 대기 중인 메시지")}>
	{#each orderQueued(queued) as q (q.mode + q.n)}
		<li animate:reflow in:rowIn out:rowOut>
			<!-- The row shows one cut line; a click opens the whole message (and its copy / remove) in the queue dialog. -->
			<button type="button" class="qo" onclick={() => { if (!dragged) onopen({ mode: q.mode, text: q.text, deferred: q.deferred }); }} title={t("자세히 보기")}>
				<QueueBadge {q} />
				<QueueText text={q.text} />
			</button>
			<button type="button" class="qx" onclick={() => oncancel({ mode: q.mode, text: q.text })} aria-label={t("{name} 취소", { name: queuedShown(q.text) })} title={t("취소")}><Icon name="x" /></button>
		</li>
	{/each}
	{#if scheduleOf}
		{#each tasks as task, i (task.id)}
			<li animate:reflow in:rowIn out:rowOut><ScheduleRow s={task} n={i + 1} serverId={scheduleOf.serverId} sessionId={scheduleOf.sessionId} blocked={() => dragged} /></li>
		{/each}
	{/if}
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
	/* Pull handle in the wrap's 12px top padding: a 4px bar 4px below the box edge, centred over the summary line.
	   The bar is 10% of the box (32px to 80px), so it stays in proportion: a fixed 32px read as a speck over a wide
	   desktop composer. The grip's content box is the bar and its side padding (--pad) widens the hit area; the hit area
	   (16px high) reaches 4px into the summary line, which is not clickable, so touch gets a fair target. */
	.grip {
		--pad: 16px;
		position: absolute;
		top: 0;
		inset-inline: 0;
		margin-inline: auto;
		box-sizing: content-box;
		width: clamp(32px, 10%, 80px);
		padding-inline: var(--pad);
		height: 16px;
		cursor: row-resize;
		touch-action: none;
		z-index: 1; /* above the summary line it overlaps */
		border-radius: var(--radius-xs);
	}
	.grip::before {
		content: "";
		position: absolute;
		top: 4px;
		inset-inline: var(--pad);
		height: 4px;
		border-radius: 2px;
		background: var(--text-faint);
		opacity: 0.5;
	}
	.grip:hover::before,
	.grip:active::before,
	.grip:focus-visible::before {
		opacity: 1;
	}
	/* A finger needs more than 16px: on touch the hit area grows to the bar + 64px (a phone's ~36px bar gives ~100px)
	   by 24px, still clear of the first row (32px down). */
	@media (pointer: coarse) {
		.grip {
			--pad: 32px;
			height: 24px;
		}
	}
	/* Shown only while the list scrolls: per-mode totals. Centred over the list, so it reads as a summary of it
	   rather than as a column that has to line up with the badges. */
	.count {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 0 0 4px;
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.c {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.c.warn {
		color: var(--warn);
	}
	.c.info {
		color: var(--info);
	}
	.count :global(svg) {
		width: 11px;
		height: 11px;
		stroke-width: 2.2;
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
		/* The ✕ below sticks out 4px (glyph aligned to the text line). Without room for it, overflow-y: auto turns
		   the visible x axis into auto too and a horizontal scrollbar appears: pad 4px inside, pull 4px back out. */
		margin: 0 -4px 0 0;
		padding: 0 4px 0 0;
		/* max-height comes from the script (1.5, 2.5 or 3.5 rows by the room left, or what the grip pulled it to). */
		overflow-x: hidden;
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
	/* The badge and the text are one button: no box of its own, the row's look stays; hover brightens the text. */
	.qo {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		text-align: left;
		color: inherit;
		font-size: inherit;
		line-height: 22px; /* the 22px row of the ✕ beside it (ROW in the script) */
		border-radius: var(--radius-xs);
	}
	@media (hover: hover) {
		.qo:hover :global(.qt) {
			color: var(--text);
		}
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
	@media (hover: hover) {
		.qx:hover {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	/* a finger needs more than 22px: the hit box grows sideways to 40px (into the 8px gap and the 4px bleed) and to 26px high,
	   the row plus the 4px gap, so the boxes of two rows meet but never overlap (rows are ROW + GAP apart) */
	@media (pointer: coarse) {
		.qx {
			position: relative;
		}
		.qx::after {
			content: "";
			position: absolute;
			inset: -2px -9px; /* 22 + 4 = 26 high, 22 + 18 = 40 wide */
		}
		/* the last row's box stops at the row: 2px past it made the list 2px taller than its rows, so a phone showed the
		   scroll summary and thumb for a list that fits */
		li:last-child .qx::after {
			bottom: 0;
		}
	}
	.qx :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
</style>
