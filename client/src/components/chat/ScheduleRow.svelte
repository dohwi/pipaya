<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import StatusDot from "../ui/StatusDot.svelte";
	import { errorText } from "../../lib/api";
	import { fullTime } from "../../lib/format";
	import { t } from "../../lib/i18n";
	import { QUEUE_BADGE_W } from "../../lib/queue";
	import { cadence, labelOf, lastRunTone, resultOf } from "../../lib/schedules";
	import { liveNext } from "../../lib/minute-clock.svelte";
	import { app } from "../../lib/store.svelte";
	import type { Schedule } from "../../lib/types";

	/**
	 * One scheduled task as a row of the queue above the input (QueuedList puts these after the waiting messages).
	 * Only switched-on tasks are listed. The row opens the task in Settings > Scheduled tasks; ✕ asks whether to pause it
	 * (it leaves the queue and stays in Settings, off) or delete it. `n`: its place among the conversation's tasks, soonest first.
	 * `blocked`: the press was a drag of the list, not a click.
	 */
	let { s, n, serverId, sessionId, blocked = () => false }: { s: Schedule; n: number; serverId: string; sessionId: string; blocked?: () => boolean } = $props();

	const tone = $derived(lastRunTone(s));
	let asking = $state(false);
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
	function pause() {
		asking = false;
		const api = app.api;
		if (!api) return;
		void run(async () => {
			app.schedules.patch(serverId, s.id, await api.patchSchedule(s.id, { enabled: false }));
			app.toast(t("‘{name}’ 예약을 일시정지했습니다", { name: labelOf(s, 40) }), "ok", sessionId);
		});
	}
	function remove() {
		asking = false;
		const api = app.api;
		if (!api) return;
		const name = labelOf(s, 40);
		const id = s.id;
		void run(async () => {
			await api.deleteSchedule(id);
			app.schedules.patch(serverId, id, null);
			app.toast(t("‘{name}’ 작업을 지웠습니다", { name }), "ok", sessionId);
		});
	}
	const tip = $derived(
		[labelOf(s, 200), cadence(s), s.nextRunAt ? t("다음 실행 {when}", { when: fullTime(s.nextRunAt) }) : null, resultOf(s)?.label].filter(Boolean).join(" · "),
	);
</script>

<button type="button" class="so" onclick={() => { if (!blocked()) app.openScheduleEdit(s.id); }} title={tip}>
	<span class="sb"><Badge size="sm" mono minWidth={QUEUE_BADGE_W}><span class="in"><Icon name="clock" /><span class="n">{n}</span></span></Badge></span>
	<span class="st"><span class="name">{labelOf(s)}</span><span class="cad">{` · ${cadence(s)}`}</span></span>
	{#if tone}<StatusDot {tone} size={6} />{/if}
	{#if s.nextRunAt}<time class="when {tone ?? ''}" datetime={new Date(s.nextRunAt).toISOString()}>{liveNext(s.nextRunAt)}</time>{/if}
</button>
<button type="button" class="sx" onclick={() => (asking = true)} disabled={busy} aria-label={t("{name} 멈추기", { name: labelOf(s) })} title={t("일시정지 또는 삭제")}><Icon name="x" /></button>

{#if asking}
	<ConfirmDialog
		id="schedule-pause"
		icon="clock"
		tone="neutral"
		title={t("‘{name}’ 예약을 멈출까요?", { name: labelOf(s, 40) })}
		description={t("일시정지하면 대기열에서 빠지고, 설정 › 예약 작업에 꺼진 채로 남아 다시 켤 수 있습니다. 삭제는 되돌릴 수 없습니다.")}
		oncancel={() => (asking = false)}
		actions={[
			{ label: t("일시정지"), variant: "primary", onclick: pause },
			{ label: t("삭제"), variant: "ghost", destructive: true, onclick: remove },
			{ label: t("취소"), variant: "ghost", onclick: () => (asking = false) },
		]}
	/>
{/if}

<style>
	/* The badge and the text are one button, like a queue row (QueuedList .qo): no box, hover brightens the name. */
	.so {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		text-align: left;
		color: inherit;
		font-size: inherit;
		line-height: 22px; /* the 22px row of the ✕ beside it (ROW in QueuedList) */
		border-radius: var(--radius-xs);
	}
	@media (hover: hover) {
		.so:hover .name {
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
	/* the name reads like a queued message's text (same colour); the cadence after it is a step quieter */
	.cad,
	.when {
		color: var(--text-faint);
	}
	.when {
		flex: none;
		font-variant-numeric: tabular-nums;
	}
	.when.warn {
		color: var(--warn);
	}
	.when.danger {
		color: var(--danger);
	}
	/* the same 22px ✕ as a queue row (QueuedList .qx) */
	.sx {
		flex: none;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-left: auto;
		margin-right: -4px; /* 22px button, 14px glyph: the glyph's right end (not the button) sits on the 16px text line */
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		cursor: pointer;
	}
	@media (hover: hover) {
		.sx:hover:not(:disabled) {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	.sx :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	/* a finger needs more than 22px, as a queue row's ✕: 40 × 26 without overlapping the next row */
	@media (pointer: coarse) {
		.sx {
			position: relative;
		}
		.sx::after {
			content: "";
			position: absolute;
			inset: -2px -9px; /* 22 + 4 = 26 high, 22 + 18 = 40 wide */
		}
		/* the list's last row: the box stops at the row, or the list scrolls by 2px (as in QueuedList) */
		:global(li:last-child) > .sx::after {
			bottom: 0;
		}
	}
</style>
