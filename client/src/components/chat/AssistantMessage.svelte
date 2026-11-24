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
	import { reveal } from "../../lib/reveal.svelte";
	import { CopyFlag } from "../../lib/copy-flag.svelte";
	import { onDestroy } from "svelte";
	import { compact, duration, fullTime } from "../../lib/format";
	import { liveMessageTime } from "../../lib/minute-clock.svelte";
	import { formatRunError } from "../../lib/chat.svelte";
	import { plainTextOf, replyActions, segmentsOf, type Segment } from "../../lib/reply-blocks";
	import { modelDisplayName } from "../../lib/model-name";
	import { replySpeed, tierLabel } from "../../lib/service-tier";
	import { SWIPE_BLOCKERS, SWIPE_TRIGGER, SwipeReply } from "../../lib/swipe-reply";
	import type { AssistantItem, Session } from "../../lib/types";
	import { tapTitle } from "../../lib/touch-hints";

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
	// The last result goes back in, so the segments that did not change keep their identity (see segmentsOf).
	let lastSegments: Segment[] = [];
	const segments = $derived((lastSegments = segmentsOf(parts.flatMap((p) => p.blocks), live, lastSegments)));
	/** Only the newest box of a streaming reply is live, and only while the reply has not moved on to writing text. */
	const liveSeg = $derived(live ? segments.length - 1 : -1);
	/** When each block was written: the time its message (one model call) started. A text the reply went on from (a
	 *  progress note between tool calls) shows it underneath; the closing text has it in the foot. */
	const blockTs = $derived(parts.flatMap((p) => p.blocks.map(() => p.ts)));
	const actions = $derived(replyActions(tail, last, live));
	/** A model that cannot think shows "off" instead of the session's level, which it ignores. */
	const tailModel = $derived(tail ? app.models.find((m) => m.provider === tail.provider && m.id === tail.model) : undefined);
	/** The name the model is registered under on this server ("Echo"), else its id as the reply recorded it ("echo-model"). */
	const modelName = $derived(modelDisplayName(app.models, tail?.provider, tail?.model));
	const tokens = $derived(parts.reduce((n, p) => n + (p.tokens ?? 0), 0));
	const took = $derived(parts.reduce((n, p) => n + (p.durationMs ?? 0), 0));
	/** The reasoning level the reply ran at: "off" for a model that cannot think (it ignores the session's level). */
	const level = $derived(tailModel && !tailModel.reasoning ? "off" : (tail?.thinkingLevel ?? ""));
	/** Speed label when non-default (or when OpenRouter fell back to another tier than requested). */
	const speed = $derived(replySpeed(parts, tail));
	const hasSpeed = $derived(speed.kind !== "none");
	/** "1.2k 토큰 · 3.4s", each part only when known: the details the line shows only with the buttons. */
	const statsMore = $derived([tokens ? t("{n} 토큰", { n: compact(tokens) }) : "", took ? duration(took) : ""].filter(Boolean).join(" · "));
	const ref = $derived(tail?.model ? (tail.provider ? `${tail.provider}/${tail.model}` : tail.model) : "");
	/** The full line on hover, with the provider and the exact token count, for when the pane cuts it short. */
	const statsTitle = $derived(
		[
			// the registered name with the exact provider/id it stands for, so the tooltip still tells two same-named models apart
			tail?.model ? (modelName !== tail.model ? `${modelName} (${ref})` : ref) : "",
			level ? `${t("추론 강도")} ${level}` : "",
			speed.kind === "fell"
				? t("요청한 속도 {asked}, 실제 처리 {served}", { asked: tierLabel(speed.asked), served: tierLabel(speed.served) })
				: speed.kind === "tier"
					? speed.confirmed
						? t("처리 속도 {tier}", { tier: speed.label })
						: t("요청한 속도 {tier}", { tier: speed.label })
					: "",
			tokens ? t("{n} 토큰", { n: tokens.toLocaleString(localeTag()) }) : "",
			took ? duration(took) : "",
		]
			.filter(Boolean)
			.join(" · "),
	);
</script>

<!-- a tap shows this answer's buttons on a touch screen (reveal.svelte.ts); the buttons themselves are reachable on their own -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="row assistant" data-part="message.assistant" class:fresh={parts[0]?.fresh} class:shown={last || reveal.key === item.key} onclick={(e) => reveal.tap(e, item.key)} use:swipeable>
	<div class="swipehint" class:armed={-swipeX >= SWIPE_TRIGGER} style:opacity={Math.min(1, -swipeX / SWIPE_TRIGGER)} aria-hidden="true"><Icon name="reply" /></div>
	<div class="content reply-card" class:swiping style:transform={swipeX ? `translateX(${swipeX}px)` : undefined}>
		{#each segments as seg, n (seg.i)}
			{#if seg.kind === "work"}
				<WorkBox steps={seg.steps} live={n === liveSeg} />
			{:else}
				<Markdown text={seg.text} streaming={live && n === segments.length - 1} sessionId={session?.id ?? null} mentions />
				{#if n < segments.length - 1 && blockTs[seg.i]}
					{@const ts = blockTs[seg.i]!}
					<time class="note-when" use:tapTitle datetime={new Date(ts).toISOString()} title={fullTime(ts)}>{liveMessageTime(ts)}</time>
				{/if}
			{/if}
		{/each}

		{#if tail && !live}
			{#if tail.stopReason === "aborted"}
				<div class="error"><Icon name="alert" /><span>{t("중지됨")}</span></div>
			{:else if tail.error}
				<div class="error">
					<Icon name="alert" />
					<span>{formatRunError(tail.error)}</span>
				</div>
			{:else if tail.stopReason === "error"}
				<div class="error"><Icon name="alert" /><span>{t("오류로 작업이 중단되었습니다.")}</span></div>
			{/if}
		{/if}

		{#if actions.cut}
			<div class="cut">
				<Notice tone="warn" role="status">
					{t("최대 출력 길이에 도달해 답변이 중간에 끊겼습니다.")}
					{#snippet action()}
						{#if actions.resume}
							<Button size="sm" disabled={app.isSending(paneId)} onclick={() => void app.continueCut(paneId)}>{t("이어서 작성")}</Button>
						{/if}
					{/snippet}
				</Notice>
			</div>
		{/if}

		{#if tail && !live}
			<div class="foot">
				<!-- the quiet line on the text's left line: when, then who wrote it and what it cost. The time comes first so a
				     narrow pane cuts the model text, never the time -->
				<span class="stats" title={statsTitle || undefined} use:tapTitle>
					{#if tail.ts}<time class="when" use:tapTitle datetime={new Date(tail.ts).toISOString()} title={fullTime(tail.ts)}>{liveMessageTime(tail.ts)}</time>{/if}
					{#if tail.ts && (tail.model || level || hasSpeed || statsMore)}<span class="sep" aria-hidden="true">·</span>{/if}
					{#if tail.model}<span class="slogo"><ModelLogo icon={tailModel?.icon} provider={tail.provider} model={tail.model} size={14} colored /></span>{/if}
					<!-- at rest: model, thinking level, and non-default speed (dot-separated); tokens and duration come with the buttons (hover, focus, or a tap on touch) -->
					{#if modelName || level || hasSpeed || statsMore}<span class="stext">{modelName}{#if level || hasSpeed}{modelName ? " · " : ""}{level}{#if level && hasSpeed}{" · "}{/if}{#if speed.kind === "fell"}<!-- a fallback stays slightly brighter: the reply was billed at a speed other than the one chosen --><span class="fell">{speed.label}</span>{:else if speed.kind === "tier"}{speed.label}{/if}{/if}{#if statsMore}<span class="more">{modelName || level || hasSpeed ? " · " : ""}{statsMore}</span>{/if}</span>{/if}
				</span>
				<!-- retry is what a failed answer needs, so it always shows; the everyday actions wait for the pointer -->
				{#if actions.retry}
					<IconButton icon="retry" label={t("다시 시도")} tip size="sm" onclick={() => app.retry(paneId)} />
				{/if}
				<span class="acts">
					<IconButton icon={copied.done ? "check" : "copy"} label={t("답변 복사")} tip size="sm" onclick={() => void copied.copy(plainText)} disabled={!plainText} />
					<IconButton icon="reply" label={t("답장")} tip size="sm" onclick={reply} disabled={!plainText} />
					{#if tail.seq !== null && session && (tail.stopReason === "stop" || tail.stopReason === "length")}
						<IconButton icon="fork" label={t("여기서 분기")} tip size="sm" onclick={() => app.fork(session.id, tail.seq!)} />
					{/if}
				</span>
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
		line-height: 20px;
		overflow-wrap: anywhere;
	}
	/* same gap above as the error box: both close the answer's text */
	.cut {
		margin-top: 8px;
	}
	.error :global(svg) {
		width: 16px;
		height: 16px;
		flex: none;
		/* 16px icon centred on the 20px first line: (20 - 16) / 2 = 2px */
		margin-top: 2px;
		stroke-width: 1.8;
	}

	/* 32px tall like every action row; starts on the text's left line (the stats text comes first, so no bleed) */
	.foot {
		display: flex;
		align-items: center;
		gap: 0;
		height: 32px;
		margin-top: 4px;
	}
	/* A 16px glyph in a 32px box leaves 8px of air on each side, so side by side boxes read 20px apart and the icons look
	   scattered. The boxes overlap 2px instead: a 28px pitch, the spacing the action rows had before they shared a size. */
	.foot :global(.iconbtn) {
		margin-inline: -2px;
	}
	/* copy / reply / branch are lighter than the app's other buttons: a 14px glyph at 1.75 in the stats line's faint colour,
	   so they read as part of that quiet line instead of three dark marks after it (16px at stroke 2 did). Hover brings the text colour */
	.foot :global(.iconbtn) {
		color: var(--text-faint);
	}
	.foot :global(.iconbtn svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.75;
	}
	@media (hover: hover) {
		.foot :global(.iconbtn:hover:not(:disabled)) {
			color: var(--text);
		}
	}
	.acts {
		display: flex;
		flex: none;
		align-items: center;
	}
	/* copy / reply / branch show while the answer is hovered or one of them has keyboard focus, like the question's own
	   actions (UserMessage.svelte); they keep their room, so nothing moves when they appear */
	.acts :global(.iconbtn) {
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.acts:has(:global(:focus-visible)) :global(.iconbtn) {
		opacity: 1;
	}
	/* hover only where it is a real pointer: a tap leaves :hover stuck on the row, and the buttons showed without taking taps */
	@media (hover: hover) {
		.row:hover .acts :global(.iconbtn) {
			opacity: 1;
		}
	}
	/* no hover on a touch screen: the newest answer keeps its buttons on, an older one shows them when tapped. Hidden ones
	   take no taps, so a tap where they sit reveals them instead of copying blind */
	@media (pointer: coarse) {
		.acts :global(.iconbtn) {
			pointer-events: none;
		}
		.row.shown .acts :global(.iconbtn) {
			opacity: 1;
			pointer-events: auto;
		}
	}
	/* "Ultrafast → Fast": one step brighter than the line it sits in, no warning colour (nothing failed, it was billed at the served speed) */
	.fell {
		color: var(--text-dim);
	}
	/* the line at rest is "time · model · level · speed"; tokens and duration show with the buttons. Nothing to its left
	   moves when it appears, and the buttons were invisible until then, so their shift goes unseen */
	.more {
		display: none;
	}
	.foot:has(:global(:focus-visible)) .more {
		display: inline;
	}
	@media (hover: hover) {
		.row:hover .more {
			display: inline;
		}
	}
	@media (pointer: coarse) {
		.row.shown .more {
			display: inline;
		}
	}
	/* the time under a progress note: on the text's left line, the foot's size and colour, 4px under the text.
	   fit-content keeps the tap target on the time text itself instead of spanning the whole row width */
	.note-when {
		display: block;
		width: fit-content;
		margin-top: 4px;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	/* when the answer was written: first in the stats line, never cut */
	.when {
		flex: none;
	}
	/* the same "·" the stats text uses between its parts, with the 4px the logo keeps on its own right */
	.sep {
		flex: none;
		margin-inline: 4px;
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
	.stext {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* whole-pixel 20px line box centred with .slogo and the 32px action row (DESIGN.md rule 3):
	   no per-child padding-bottom lift, which grew the text boxes to 22px and dropped the 14px logo 1px low */
	.stats {
		display: flex;
		flex: 0 1 auto;
		align-items: center;
		min-width: 0;
		margin-right: 4px; /* the next box overlaps 2px and holds its 14px glyph 9px in: 11px to the ink */
		font-size: var(--fs-2xs);
		line-height: 20px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
	}
</style>
