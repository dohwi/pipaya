<script lang="ts">
	import IconButton from "../ui/IconButton.svelte";
	import { localeTag, t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import Markdown from "./Markdown.svelte";
	import WorkBox from "./WorkBox.svelte";
	import ModelLogo from "../models/ModelLogo.svelte";
	import Notice from "../ui/Notice.svelte";
	import Button from "../ui/Button.svelte";
	import { app } from "../../lib/store.svelte";
	import { CopyFlag } from "../../lib/copy-flag.svelte";
	import { onDestroy } from "svelte";
	import { compact, duration, timeOfDay } from "../../lib/format";
	import { plainTextOf, replyActions, segmentsOf } from "../../lib/reply-blocks";
	import { SWIPE_BLOCKERS, SWIPE_TRIGGER, SwipeReply } from "../../lib/swipe-reply";
	import type { AssistantItem, Session } from "../../lib/types";

	/**
	 * An answer: its text and work boxes in order, then (when it is done) copy / reply / branch / retry buttons and a
	 * line of stats. Several consecutive assistant messages answering one prompt (`turn`) read as one answer. On a phone
	 * the answer can be dragged right to left to reply to it.
	 *
	 *  live  the agent is still writing it
	 *  last  the newest answer (the only one that can be retried or continued)
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
	/** When each block was written: the time its message (one model call) started. A text the reply went on from (a
	 *  progress note between tool calls) shows it underneath; the closing text has it in the foot. */
	const blockTs = $derived(parts.flatMap((p) => p.blocks.map(() => p.ts)));
	const actions = $derived(replyActions(tail, last, live));
	/** A model that cannot think shows "off" instead of the session's level, which it ignores. */
	const tailModel = $derived(tail ? app.models.find((m) => m.provider === tail.provider && m.id === tail.model) : undefined);
	const tokens = $derived(parts.reduce((n, p) => n + (p.tokens ?? 0), 0));
	const took = $derived(parts.reduce((n, p) => n + (p.durationMs ?? 0), 0));
	/** The reasoning level the reply ran at: "off" for a model that cannot think (it ignores the session's level). */
	const level = $derived(tailModel && !tailModel.reasoning ? "off" : (tail?.thinkingLevel ?? ""));
	/** "model · level · 1.2k 토큰 · 3.4s", each part only when known. */
	const statsText = $derived(
		[tail?.model ?? "", level, tokens ? t("{n} 토큰", { n: compact(tokens) }) : "", took ? duration(took) : ""].filter(Boolean).join(" · "),
	);
	/** The full line on hover, with the provider and the exact token count, for when the pane cuts it short. */
	const statsTitle = $derived(
		[
			tail?.model ? (tail.provider ? `${tail.provider}/${tail.model}` : tail.model) : "",
			level ? `${t("추론 강도")} ${level}` : "",
			tokens ? t("{n} 토큰", { n: tokens.toLocaleString(localeTag()) }) : "",
			took ? duration(took) : "",
		]
			.filter(Boolean)
			.join(" · "),
	);
</script>

<div class="row assistant" data-part="message.assistant" class:fresh={parts[0]?.fresh} use:swipeable>
	<div class="swipehint" class:armed={-swipeX >= SWIPE_TRIGGER} style:opacity={Math.min(1, -swipeX / SWIPE_TRIGGER)} aria-hidden="true"><Icon name="reply" /></div>
	<div class="content reply-card" class:swiping style:transform={swipeX ? `translateX(${swipeX}px)` : undefined}>
		{#each segments as seg, n (seg.i)}
			{#if seg.kind === "work"}
				<WorkBox steps={seg.steps} live={n === liveSeg} />
			{:else}
				<Markdown text={seg.text} streaming={live && n === segments.length - 1} sessionId={session?.id ?? null} />
				{#if n < segments.length - 1 && blockTs[seg.i]}
					{@const ts = blockTs[seg.i]!}
					<time class="note-when" datetime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString(localeTag())}>{timeOfDay(ts, localeTag())}</time>
				{/if}
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

		{#if actions.cut}
			<div class="cut">
				{#if actions.resume}
					<Notice tone="warn" size="sm" role="status">
						{t("최대 출력 길이에 도달해 답변이 중간에 끊겼습니다.")}
						{#snippet action()}
							<Button size="sm" disabled={app.sending} onclick={() => void app.continueCut(paneId)}>{t("이어서 작성")}</Button>
						{/snippet}
					</Notice>
				{:else}
					<Notice tone="warn" size="sm" role="status">{t("최대 출력 길이에 도달해 답변이 중간에 끊겼습니다.")}</Notice>
				{/if}
			</div>
		{/if}

		{#if tail && !live}
			<div class="foot">
				<IconButton icon={copied.done ? "check" : "copy"} label={t("답변 복사")} size="sm" onclick={() => void copied.copy(plainText)} disabled={!plainText} />
				<IconButton icon="reply" label={t("답장")} tip size="sm" onclick={reply} disabled={!plainText} />
				{#if tail.seq !== null && session && (tail.stopReason === "stop" || tail.stopReason === "length")}
					<IconButton icon="fork" label={t("여기서 분기")} tip size="sm" onclick={() => app.fork(session.id, tail.seq!)} />
				{/if}
				{#if actions.retry}
					<IconButton icon="retry" label={t("다시 시도")} tip size="sm" onclick={() => app.retry(paneId)} />
				{/if}
				<!-- who wrote it and what it cost, right after the buttons; cut first when the pane is narrow -->
				{#if tail.model || tokens || took}
					<span class="stats" title={statsTitle}>
						{#if tail.model}<span class="slogo"><ModelLogo icon={tailModel?.icon} provider={tail.provider} model={tail.model} size={13} colored /></span>{/if}
						<span class="stext">{statsText}</span>
					</span>
				{/if}
				<!-- when, last and on the right line: the same place the question's time sits, so every time in the column lines up -->
				{#if tail.ts}<time class="when" datetime={new Date(tail.ts).toISOString()} title={new Date(tail.ts).toLocaleString(localeTag())}>{timeOfDay(tail.ts, localeTag())}</time>{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.row {
		display: flex;
		gap: 12px;
		padding: 8px 0;
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
			gap: 8px;
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
		padding: 4px 0 0;
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
		margin-top: 8px;
		padding: 8px 12px;
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: var(--fs-sm);
		overflow-wrap: anywhere;
	}
	/* same gap above as the error box: both close the answer's text */
	.cut {
		margin-top: 8px;
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
		gap: 0;
		margin-top: 4px;
		/* 8px glyph inset less the 2px the first box is pulled in: the first glyph lands on the text's left edge */
		margin-left: -6px;
	}
	/* Only the buttons rest faded until the answer is hovered: the whole line used to, and the model / token text in it
	   then read 2.3:1 (light theme). The text stays --text-faint at full strength (6:1); the buttons stay quiet. */
	.foot :global(.iconbtn) {
		opacity: 0.55;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	/* A 16px glyph in a 32px box leaves 8px of air on each side, so side by side boxes read 20px apart and the icons look
	   scattered. The boxes overlap 2px instead: a 28px pitch, the spacing the action rows had before they shared a size. */
	.foot :global(.iconbtn) {
		margin-inline: -2px;
	}
	.row:hover .foot :global(.iconbtn),
	.foot:has(:focus-visible) :global(.iconbtn) {
		opacity: 1;
	}
	/* no hover on a touch screen: full strength there, as the user message's actions are (UserMessage.svelte) */
	@media (pointer: coarse) {
		.foot :global(.iconbtn) {
			opacity: 1;
		}
	}
	/* the 13px mark's ink lands on the row centre with the 16px button glyphs: at -2px it sat 0.5px high of them and
	   1.5px high of the text's body, which is what reads as "the logo and the model name do not line up" */
	/* the time under a progress note: on the text's left line, the foot's size and colour, 4px under the text */
	.note-when {
		display: block;
		margin-top: 4px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	/* when the answer was written: pushed to the row's right end, 8px clear of the stats, never cut. The foot only bleeds on
	   the left (for the first glyph), so the time's right edge is the content's right line, where the question's time ends */
	.when {
		flex: none;
		margin-left: auto;
		padding-left: 8px;
		padding-bottom: 2px; /* same lift as .stext: the x-height onto the glyph centre */
		font-size: var(--fs-2xs);
		line-height: 20px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.slogo {
		display: flex;
		flex: none;
		align-items: center;
		margin-right: 4px;
	}
	.slogo :global(.model) {
		display: block;
	}
	/* measured: in a 20px line the lowercase x-height centre sits 1.2px under the box centre (icon glyphs 16.2, text 17.3);
	   2px of bottom padding moves the text, not the row, up 1px onto the glyph centre */
	.stext {
		min-width: 0;
		padding-bottom: 2px;
		line-height: 20px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* an 11px line centred as a box puts its baseline 4.1px under the row centre, so the lowercase body rides 1px low
	   next to the 16px glyphs; 2px of bottom margin lifts the text (not the box) onto the row centre */
	.stats {
		display: flex;
		align-items: center;
		min-width: 0;
		margin-left: 8px;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
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
			font-size: var(--fs-2xs);
		}
	}
</style>
