<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import StatusDot from "../ui/StatusDot.svelte";
	import { errorText } from "../../lib/api";
	import { fullTime } from "../../lib/format";
	import { t } from "../../lib/i18n";
	import { reflow, rowIn, rowOut } from "../../lib/motion";
	import { cadence, labelOf, lastRunTone, nextRunLabel, resultOf } from "../../lib/schedules";
	import { app } from "../../lib/store.svelte";
	import type { Schedule } from "../../lib/types";

	/**
	 * The scheduled tasks of one conversation, above its input like the message queue (QueuedList). Folded by default:
	 * the soonest task and a "+N" that unfolds the rest. A row opens the task in Settings > Scheduled tasks; the button
	 * at its end pauses (asking whether to pause or delete) or switches a paused task back on. Paused tasks stay, dimmed.
	 * `divided`: the message queue follows, so a hairline separates the two lists.
	 */
	let { items, serverId, sessionId, divided = false }: { items: Schedule[]; serverId: string; sessionId: string; divided?: boolean } = $props();

	let open = $state(false);
	const shown = $derived(open ? items : items.slice(0, 1));
	const more = $derived(items.length - 1);
	// Once one task is left there is nothing to unfold: the next time there are more it starts folded again.
	$effect(() => {
		if (items.length < 2) open = false;
	});

	// Unfolded past 3.5 rows the list scrolls: the edge that hides rows fades, as in QueuedList.
	let ul = $state<HTMLUListElement>();
	let fadeTop = $state(false);
	let fadeBottom = $state(false);
	function syncFade() {
		if (!ul) return;
		fadeTop = ul.scrollTop > 1;
		fadeBottom = ul.scrollTop + ul.clientHeight < ul.scrollHeight - 1;
	}
	// Rows grow in with a transition, so the list's height settles after the change: follow it and its rows' sizes.
	$effect(() => {
		const list = ul;
		void shown.length;
		if (!list || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(syncFade);
		ro.observe(list);
		for (const li of list.children) ro.observe(li);
		return () => ro.disconnect();
	});

	let asking = $state<Schedule | null>(null);
	let busy = $state(false);

	async function run(fn: () => Promise<void>) {
		if (busy) return;
		busy = true;
		try {
			await fn();
		} catch (e) {
			app.toast(errorText(e), "error", sessionId);
		} finally {
			busy = false;
		}
	}
	function pause(s: Schedule) {
		asking = null;
		const api = app.api;
		if (!api) return;
		void run(async () => {
			app.schedules.patch(serverId, s.id, await api.patchSchedule(s.id, { enabled: false }));
			app.toast(t("‘{name}’ 예약을 일시정지했습니다", { name: labelOf(s, 40) }), "ok", sessionId);
		});
	}
	function remove(s: Schedule) {
		asking = null;
		const api = app.api;
		if (!api) return;
		void run(async () => {
			await api.deleteSchedule(s.id);
			app.schedules.patch(serverId, s.id, null);
			app.toast(t("‘{name}’ 작업을 지웠습니다", { name: labelOf(s, 40) }), "ok", sessionId);
		});
	}
	function resume(s: Schedule) {
		// A one-time task whose time has passed needs a new one first: the settings form asks for it.
		if (s.kind === "once" && (s.runAt ?? 0) <= Date.now()) return app.openScheduleEdit(s.id);
		const api = app.api;
		if (!api) return;
		void run(async () => app.schedules.patch(serverId, s.id, await api.patchSchedule(s.id, { enabled: true })));
	}

	const tipOf = (s: Schedule): string => {
		const result = resultOf(s);
		return [labelOf(s, 200), cadence(s), s.enabled && s.nextRunAt ? t("다음 실행 {when}", { when: fullTime(s.nextRunAt) }) : t("꺼져 있음"), result?.label].filter(Boolean).join(" · ");
	};
</script>

<div class="sched-wrap" class:divided>
	<ul class="sched" class:open class:fade-top={fadeTop} class:fade-bottom={fadeBottom} bind:this={ul} onscroll={syncFade} aria-label={t("이 대화의 예약 작업")}>
		{#each shown as s, i (s.id)}
			{@const tone = s.enabled ? lastRunTone(s) : null}
			<li class:off={!s.enabled} animate:reflow in:rowIn out:rowOut>
				<button type="button" class="so" onclick={() => app.openScheduleEdit(s.id)} title={tipOf(s)}>
					<span class="sb"><Badge size="sm" mono><span class="in"><Icon name="clock" /><span class="n">{open ? i + 1 : items.length}</span></span></Badge></span>
					<span class="st"><span class="name">{labelOf(s)}</span> · {cadence(s)}</span>
					{#if tone}<StatusDot {tone} size={6} />{/if}
					<span class="when {tone ?? ''}">{s.enabled && s.nextRunAt ? t("다음 {when}", { when: nextRunLabel(s.nextRunAt) }) : t("꺼짐")}</span>
				</button>
				{#if i === 0 && more > 0 && !open}
					<button type="button" class="tog" onclick={() => (open = true)} aria-expanded="false" title={t("펼치기")} aria-label={t("펼치기")}><span class="plus">+{more}</span><Icon name="chevron-down" /></button>
				{/if}
				{#if s.enabled}
					<button type="button" class="sx" onclick={() => (asking = s)} disabled={busy} aria-label={t("{name} 일시정지", { name: labelOf(s) })} title={t("일시정지")}><Icon name="pause" /></button>
				{:else}
					<button type="button" class="sx" onclick={() => resume(s)} disabled={busy} aria-label={t("{name} 켜기", { name: labelOf(s) })} title={t("켜기")}><Icon name="play" /></button>
				{/if}
			</li>
		{/each}
	</ul>
	{#if open}
		<!-- under the list, not in the first row: a button there pushed that row's time off the column of the others -->
		<button type="button" class="fold" onclick={() => (open = false)} aria-expanded="true" title={t("접기")} aria-label={t("접기")}><Icon name="chevron-up" /></button>
	{/if}
</div>

{#if asking}
	{@const s = asking}
	<ConfirmDialog
		id="schedule-pause"
		icon="clock"
		tone="neutral"
		title={t("‘{name}’ 예약을 멈출까요?", { name: labelOf(s, 40) })}
		description={t("일시정지하면 꺼진 채로 남아 언제든 다시 켤 수 있습니다. 삭제는 되돌릴 수 없습니다.")}
		oncancel={() => (asking = null)}
		actions={[
			{ label: t("일시정지"), variant: "primary", onclick: () => pause(s) },
			{ label: t("삭제"), variant: "ghost", destructive: true, onclick: () => remove(s) },
			{ label: t("취소"), variant: "ghost", onclick: () => (asking = null) },
		]}
	/>
{/if}

<style>
	/* 12px 16px = the textarea's own padding, as in QueuedList: badges start on the text line, the button glyph ends on it. */
	.sched-wrap {
		padding: 12px 16px 0;
	}
	/* The message queue follows: a hairline 12px under these rows, and the queue's own 12px top padding above it. */
	.divided::after {
		content: "";
		display: block;
		height: 1px;
		margin-top: 12px;
		background: var(--border);
	}
	.sched {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	/* Unfolded, a long list scrolls inside 3.5 rows (3 × 22 + 3 × 4 + 11) so it never pushes the input off screen. */
	.sched.open {
		max-height: 89px; /* 3.5 rows of 22px with 4px gaps, the half row reads as scrollable */
		overflow-y: auto;
		overscroll-behavior: contain;
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
	/* a 16px strip under the list (on the 4px row gap), centred like QueuedList's grip */
	.fold {
		display: grid;
		place-items: center;
		width: 32px;
		height: 16px;
		margin: 4px auto 0;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
	}
	.sched li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: var(--fs-xs);
		color: var(--text-dim);
	}
	.so {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		text-align: left;
		color: inherit;
		font-size: inherit;
		line-height: 22px; /* the 22px row of the buttons beside it */
		border-radius: var(--radius-xs);
	}
	@media (hover: hover) {
		.so:hover .st {
			color: var(--text);
		}
	}
	.sb {
		display: inline-flex;
		flex: none;
	}
	.in {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0 1px;
	}
	/* as QueueBadge: the badge's 1px bottom padding is given back to the icon so it sits on the pill's centre */
	.in :global(svg) {
		width: 12px;
		height: 12px;
		margin-bottom: -1px;
		stroke-width: 2.2;
	}
	.n {
		font-variant-numeric: tabular-nums;
	}
	.st {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name {
		color: var(--text);
	}
	.when {
		flex: none;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.when.warn {
		color: var(--warn);
	}
	.when.danger {
		color: var(--danger);
	}
	/* Paused: still listed (it can be switched back on here), dimmed like a switched-off row in Settings. */
	.off .sb,
	.off .st,
	.off .when {
		opacity: 0.55;
	}
	.tog {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 22px;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		font-size: var(--fs-xs);
		font-variant-numeric: tabular-nums;
	}
	.plus {
		line-height: 16px;
	}
	.sx {
		flex: none;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-right: -4px; /* 22px button, 14px glyph: the glyph's right end sits on the 16px text line (as QueuedList's ✕) */
		border-radius: var(--radius-sm);
		color: var(--text-faint);
	}
	@media (hover: hover) {
		.tog:hover,
		.fold:hover,
		.sx:hover:not(:disabled) {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	.tog :global(svg),
	.fold :global(svg),
	.sx :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	/* the play triangle is a filled shape: the line icon's stroke alone reads too thin beside the pause bars */
	.off .sx :global(svg) {
		fill: currentColor;
	}
	/* a finger needs more than 22px, as in QueuedList: the hit box grows to 40 × 26 without overlapping the next row */
	@media (pointer: coarse) {
		.sx {
			position: relative;
		}
		.sx::after {
			content: "";
			position: absolute;
			inset: -2px -9px; /* 22 + 4 = 26 high, 22 + 18 = 40 wide */
		}
	}
</style>
