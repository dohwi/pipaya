<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import ConfirmDialog from "../ui/ConfirmDialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import { errorText } from "../../lib/api";
	import { t } from "../../lib/i18n";
	import { QUEUE_BADGE_W } from "../../lib/queue";
	import { goalLabel, goalLevel, goalTone, goalUsage } from "../../lib/goals";
	import { app } from "../../lib/store.svelte";
	import type { Goal } from "../../lib/types";

	/**
	 * The conversation's goal as the first row of the queue above the input (QueuedList): what the next turn will work on
	 * by itself, so it sits with the messages that wait for it. The row opens the goal dialog; ✕ asks whether to pause it
	 * (it stays, and /goal resume or the dialog starts it again) or clear it, like a scheduled task's ✕ (ScheduleRow).
	 * `blocked`: the press was a drag of the list, not a click.
	 */
	let { g, serverId, sessionId, blocked = () => false }: { g: Goal; serverId: string; sessionId: string; blocked?: () => boolean } = $props();

	const level = $derived(goalLevel(g));
	let asking = $state(false);
	let busy = $state(false);
	const tip = $derived([g.objective, goalLabel(g.status), goalUsage(g)].join(" · "));

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
			app.goals.patch(serverId, sessionId, await api.patchGoal(sessionId, { status: "paused" }));
			app.toast(t("목표를 일시정지했습니다. /goal resume으로 이어 갑니다"), "ok", sessionId);
		});
	}
	function clear() {
		asking = false;
		const api = app.api;
		if (!api) return;
		void run(async () => {
			await api.deleteGoal(sessionId);
			app.goals.patch(serverId, sessionId, null);
			app.toast(t("목표를 지웠습니다"), "ok", sessionId);
		});
	}
</script>

<button type="button" class="go" onclick={() => { if (!blocked()) app.openGoal(sessionId); }} title={tip}>
	<span class="gb"><Badge size="sm" tone={goalTone(g.status)} minWidth={QUEUE_BADGE_W}><span class="in"><Icon name="target" />{t("목표")}</span></Badge></span>
	<span class="gt"><span class="obj">{g.objective}</span>{#if g.status !== "active"}<span class="st {goalTone(g.status)}">{` · ${goalLabel(g.status)}`}</span>{/if}</span>
	<span class="use {level}">{goalUsage(g)}</span>
</button>
<button type="button" class="gx" onclick={() => (asking = true)} disabled={busy} aria-label={t("목표 멈추기")} title={t("일시정지 또는 지우기")}><Icon name="x" /></button>

{#if asking}
	<ConfirmDialog
		id="goal-stop"
		icon="target"
		tone="neutral"
		title={t("목표를 멈출까요?")}
		description={g.status === "active"
			? t("일시정지하면 지금 턴이 끝난 뒤 이어서 진행하지 않고, 목표는 대기열에 남습니다. 지우면 진행 기록도 함께 사라집니다.")
			: t("지우면 목표와 진행 기록이 사라집니다.")}
		oncancel={() => (asking = false)}
		actions={[
			...(g.status === "active" ? [{ label: t("일시정지"), variant: "primary" as const, onclick: pause }] : []),
			{ label: t("지우기"), variant: "ghost", destructive: true, onclick: clear },
			{ label: t("취소"), variant: "ghost", onclick: () => (asking = false), focus: g.status !== "active" },
		]}
	/>
{/if}

<style>
	/* The same row as a queued message or a scheduled task (QueuedList .qo, ScheduleRow .so): badge + one cut line, no box. */
	.go {
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
		.go:hover .obj {
			color: var(--text);
		}
	}
	.gb {
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
	.gt {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.st,
	.use {
		color: var(--text-faint);
	}
	.st.warn,
	.use.warn {
		color: var(--warn);
	}
	.st.danger,
	.use.danger {
		color: var(--danger);
	}
	.use {
		flex: none;
		font-variant-numeric: tabular-nums;
	}
	/* the same 22px ✕ as a queue row (QueuedList .qx) */
	.gx {
		flex: none;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		margin-left: auto;
		margin-right: -4px; /* 22px button, 14px glyph: the glyph's right end (not the button) sits on the 16px text line */
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		cursor: pointer;
	}
	@media (hover: hover) {
		.gx:hover:not(:disabled) {
			color: var(--text);
			background: var(--bg-hover);
		}
	}
	.gx :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 2;
	}
	/* a finger needs more than 22px, as a queue row's ✕: 40 × 26 without overlapping the next row */
	@media (pointer: coarse) {
		.gx {
			position: relative;
		}
		.gx::after {
			content: "";
			position: absolute;
			inset: -2px -9px; /* 22 + 4 = 26 high, 22 + 18 = 40 wide */
		}
		:global(li:last-child) > .gx::after {
			bottom: 0;
		}
	}
</style>
