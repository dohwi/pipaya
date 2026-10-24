<script lang="ts">
	import IconButton from "../IconButton.svelte";
	import { t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import Markdown from "../Markdown.svelte";
	import WorkBox from "../WorkBox.svelte";
	import ModelLogo from "../ModelLogo.svelte";
	import { app } from "../../lib/store.svelte";
	import { CopyFlag } from "../../lib/copy-flag.svelte";
	import { onDestroy } from "svelte";
	import { compact, duration } from "../../lib/format";
	import { plainTextOf, segmentsOf } from "../../lib/reply-blocks";
	import { SWIPE_BLOCKERS, SWIPE_TRIGGER, SwipeReply } from "../../lib/swipe-reply";
	import type { AssistantItem, Session } from "../../lib/types";

	/**
	 * An answer: its text and work boxes in order, then (when it is done) copy / reply / branch / retry buttons and a
	 * line of stats. Several consecutive assistant messages answering one prompt (`turn`) read as one answer. On a phone
	 * the answer can be dragged right to left to reply to it.
	 *
	 *  live  the agent is still writing it
	 *  last  the newest answer (the only one that can be retried)
	 */
	let {
		item,
		turn = [],
		last = false,
		live = false,
		session,
		paneId,
		onreply,
	}: { item: AssistantItem; turn?: AssistantItem[]; last?: boolean; live?: boolean; session: Session | undefined; paneId: string | null; onreply: (text: string) => void } = $props();

	const parts = $derived<AssistantItem[]>(turn.length ? turn : [item]);
	const tail = $derived(parts[parts.length - 1]);
	const plainText = $derived(plainTextOf(parts.flatMap((p) => p.blocks)));
	const reply = () => onreply(plainText);

	/**
	 * Mobile: drag an answer right -> left to reply to it. The gesture is lib/swipe-reply (plain TS); the two numbers the
	 * template needs are mirrored into runes after every touch event.
	 */
	const gesture = new SwipeReply();
	let swipeX = $state(0);
	let swiping = $state(false);
	const sync = () => {
		swipeX = gesture.x;
		swiping = gesture.swiping;
	};

	function swipeable(node: HTMLElement) {
		const canReply = () => !live && !!plainText;
		const start = (e: TouchEvent) => {
			// Horizontally scrollable content (code, tables, formulas) and form fields keep their own gestures.
			const blocked = (e.target as Element | null)?.closest(SWIPE_BLOCKERS);
			gesture.start(e.touches.length, e.touches[0]?.clientX ?? 0, e.touches[0]?.clientY ?? 0, canReply() && !blocked);
		};
		const move = (e: TouchEvent) => {
			const m = gesture.move(e.touches[0]!.clientX, e.touches[0]!.clientY);
			if (!m.handled) return;
			e.preventDefault();
			if (m.justArmed) navigator.vibrate?.(10);
			sync();
		};
		const end = () => {
			if (gesture.end()) reply();
			sync();
		};
		const cancel = () => {
			gesture.reset();
			sync();
		};
		node.addEventListener("touchstart", start, { passive: true });
		node.addEventListener("touchmove", move, { passive: false });
		node.addEventListener("touchend", end);
		node.addEventListener("touchcancel", cancel);
		return {
			destroy() {
				node.removeEventListener("touchstart", start);
				node.removeEventListener("touchmove", move);
				node.removeEventListener("touchend", end);
				node.removeEventListener("touchcancel", cancel);
			},
		};
	}

	const copied = new CopyFlag();
	onDestroy(() => copied.dispose());

	/** Thoughts and tool calls between two pieces of text share one work box; text keeps its place around it. */
	const segments = $derived(segmentsOf(parts.flatMap((p) => p.blocks), live));
	/** Only the newest box of a streaming reply is live, and only while the reply has not moved on to writing text. */
	const liveSeg = $derived(live ? segments.length - 1 : -1);
	const canRetry = $derived(!!tail && last && !live && (tail.stopReason === "error" || tail.stopReason === "aborted"));
	const tokens = $derived(parts.reduce((n, p) => n + (p.tokens ?? 0), 0));
	const took = $derived(parts.reduce((n, p) => n + (p.durationMs ?? 0), 0));
</script>

<div class="row assistant" data-part="message.assistant" class:fresh={parts[0]?.fresh} use:swipeable>
	<div class="swipehint" class:armed={-swipeX >= SWIPE_TRIGGER} style:opacity={Math.min(1, -swipeX / SWIPE_TRIGGER)} aria-hidden="true"><Icon name="reply" /></div>
	<div class="content reply-card" class:swiping style:transform={swipeX ? `translateX(${swipeX}px)` : undefined}>
		{#each segments as seg, n (seg.i)}
			{#if seg.kind === "work"}
				<WorkBox steps={seg.steps} live={n === liveSeg} />
			{:else}
				<Markdown text={seg.text} streaming={live && n === segments.length - 1} sessionId={session?.id ?? null} />
			{/if}
		{/each}

		{#if tail && !live}
			{#if tail.error}
				<div class="error">
					<Icon name="alert" />
					<span>{tail.stopReason === "aborted" ? t("중지됨") : tail.error}</span>
				</div>
			{:else if tail.stopReason === "aborted"}
				<div class="error"><Icon name="alert" /><span>{t("중지됨")}</span></div>
			{/if}
		{/if}

		{#if tail && !live}
			<div class="foot">
				<IconButton icon={copied.done ? "check" : "copy"} label={t("답변 복사")} size="sm" onclick={() => void copied.copy(plainText)} disabled={!plainText} />
				<IconButton icon="reply" label={t("답장")} tip size="sm" onclick={reply} disabled={!plainText} />
				{#if tail.seq !== null && session && (tail.stopReason === "stop" || tail.stopReason === "length")}
					<IconButton icon="fork" label={t("여기서 분기")} tip size="sm" onclick={() => app.fork(session.id, tail.seq!)} />
				{/if}
				{#if canRetry}
					<IconButton icon="retry" label={t("다시 시도")} tip size="sm" onclick={() => app.retry(paneId)} />
				{/if}
				<span class="stats">
					{#if tail.model}<span class="slogo"><ModelLogo icon={app.models.find((m) => m.provider === tail.provider && m.id === tail.model)?.icon} provider={tail.provider} model={tail.model} size={13} /></span>{tail.model}{/if}
					{#if tail.thinkingLevel}· {tail.thinkingLevel}{/if}
					{#if tokens}· {t("{n} 토큰", { n: compact(tokens) })}{/if}
					{#if took}· {duration(took)}{/if}
				</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.row {
		display: flex;
		gap: 12px;
		padding: 10px 0;
	}
	.fresh {
		animation: rise var(--motion-normal) var(--ease) both;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	@media (max-width: 640px) {
		.row {
			gap: 10px;
		}
	}

	/* assistant: the reply fills the full width */
	.row.assistant {
		position: relative;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
	}
	.content {
		flex: none;
		min-width: 0;
		width: 100%;
	}
	/* one prompt -> one answer: the turn's steps and text flow as plain content, no box */
	.reply-card {
		padding: 2px 0 0;
		transition: transform var(--motion-fast) var(--ease-std);
	}
	.reply-card.swiping {
		transition: none;
	}
	.swipehint {
		position: absolute;
		right: 4px;
		top: 50%;
		translate: 0 -50%;
		display: none;
		opacity: 0;
		color: var(--text-faint);
		pointer-events: none;
	}
	.swipehint.armed {
		color: var(--accent, currentColor);
	}
	.swipehint :global(svg) {
		width: 20px;
		height: 20px;
	}
	@media (pointer: coarse) {

		.swipehint {
			display: block;
		}
	}

	.error {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-top: 10px;
		padding: 9px 12px;
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}
	.error :global(svg) {

		width: 17px;

		height: 17px;

		flex: none;

		margin-top: 1px;

		stroke-width: 1.8;

	}

	.foot {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-top: 4px;
		margin-left: -6px;
		opacity: 0.55;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.row:hover .foot,
	.foot:focus-within {
		opacity: 1;
	}
	.slogo {
		display: inline-flex;
		vertical-align: -2px;
		margin-right: 4px;
	}
	.stats {
		margin-left: 8px;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* narrow pane: the stats line gives way before the buttons do, and the text shrinks a notch */
	@container (max-width: 420px) {

		.foot {
			min-width: 0;
		}
		.stats {
			flex: 1;
			min-width: 0;
			margin-left: 4px;
			font-size: 10px;
		}
	}
</style>
