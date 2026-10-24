<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import Markdown from "./Markdown.svelte";
	import WorkBox from "./WorkBox.svelte";
	import FileChip from "./FileChip.svelte";
	import ModelLogo from "./ModelLogo.svelte";
	import { app } from "../lib/store.svelte";
	import { copyText } from "../lib/clipboard";
	import { compact, duration } from "../lib/format";
	import { splitImageTokens } from "../lib/composer-text";
	import { getPane } from "../lib/pane";
	import { extensions } from "../lib/extensions/host.svelte";
	import { splitQuote } from "../lib/quote";
	import { plainTextOf, segmentsOf } from "../lib/reply-blocks";
	import { SWIPE_BLOCKERS, SWIPE_TRIGGER, SwipeReply } from "../lib/swipe-reply";
	import type { AssistantItem, UserItem } from "../lib/types";

	/**
	 * `turn`: for an assistant row, every consecutive assistant message answering one prompt (one LLM call each);
	 * they render as a single reply. `live`: the agent is still on this turn. `working`: this is the prompt it is busy answering.
	 */
	let {
		item,
		turn = [],
		last = false,
		live = false,
		working = false,
	}: { item: UserItem | AssistantItem; turn?: AssistantItem[]; last?: boolean; live?: boolean; working?: boolean } = $props();

	const pane = getPane();
	const session = $derived(app.session(pane.id));

	const parts = $derived<AssistantItem[]>(item.kind === "assistant" ? (turn.length ? turn : [item]) : []);
	const tail = $derived(parts[parts.length - 1]);

	/** Set when an extension recognises the message as sent by another session (`sdk.messages.setHeader`). */
	const peer = $derived(item.kind === "user" ? extensions.headerOf(item.text) : null);
	const shown = $derived(item.kind === "user" ? splitQuote(peer ? peer.body : item.text) : { quote: "", rest: "" });

	/** Hand this message to the composer as a reply badge, so the next prompt answers it. */
	function reply() {
		app.replyTo = { text: item.kind === "user" ? (peer ? peer.body : item.text) : plainText, who: peer ? peer.from : undefined };
	}

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
		const canReply = () => item.kind === "assistant" && !live && !!plainText;
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

	let copied = $state(false);
	let expanded = $state(false);

	const plainText = $derived(item.kind === "user" ? item.text : plainTextOf(parts.flatMap((p) => p.blocks)));

	async function copy() {
		if (await copyText(plainText)) {
			copied = true;
			setTimeout(() => (copied = false), 1400);
		}
	}

	/** Thoughts and tool calls between two pieces of text share one work box; text keeps its place around it. */
	const segments = $derived(item.kind === "assistant" ? segmentsOf(parts.flatMap((p) => p.blocks), live) : []);
	/** Only the newest box of a streaming reply is live, and only while the reply has not moved on to writing text. */
	const liveSeg = $derived(live ? segments.length - 1 : -1);
	const canRetry = $derived(!!tail && last && !live && (tail.stopReason === "error" || tail.stopReason === "aborted"));
	const tokens = $derived(parts.reduce((n, p) => n + (p.tokens ?? 0), 0));
	const took = $derived(parts.reduce((n, p) => n + (p.durationMs ?? 0), 0));
</script>

{#if item.kind === "user"}
	<div class="row user" class:peer={!!peer} class:fresh={item.fresh}>
		<div class="bubble" class:peerbubble={!!peer} class:glow-working={working} data-level={working && app.effectiveModelOf(pane.id)?.reasoning ? app.effectiveOf(pane.id).thinkingLevel : undefined}>
			{#if item.images.length}
				<div class="imgs">
					{#each item.images as img, i}
						<button class="zoom" onclick={() => app.openImage(item.images.map((m) => ({ src: `data:${m.mimeType};base64,${m.data}`, mimeType: m.mimeType })), i)} aria-label={t("이미지 크게 보기")}>
							<img src={`data:${img.mimeType};base64,${img.data}`} alt={t("첨부 이미지 {n}", { n: i + 1 })} />
						</button>
					{/each}
				</div>
			{/if}
			{#if item.files?.length}
				<div class="filechips">
					{#each item.files as f}
						<FileChip name={f.name} size={f.size} onopen={f.path && session ? () => app.openFile(session.id, f) : undefined} />
					{/each}
				</div>
			{/if}
			{#if peer}
				<div class="from"><Icon name="chat" /> <span>{peer.from}</span></div>
			{/if}
			{#if shown.quote}
				<blockquote class="quote">{shown.quote}</blockquote>
			{/if}
			{#if shown.rest}
				<div class="txt" class:clamp={item.note?.collapse && !expanded}>{shown.rest}</div>
			{/if}
			{#if item.note}
				<div class="tplnote" title={item.note.call}>
					<span>{item.note.text}</span>
					{#if item.note.collapse && (item.text.length > 400 || item.text.split("\n").length > 8)}
						<button class="more" onclick={() => (expanded = !expanded)}>{expanded ? t("접기") : t("더 보기")}</button>
					{/if}
				</div>
			{/if}
		</div>
		<div class="actions">
			<button class="iconbtn sm" onclick={copy} aria-label={t("메시지 복사")}><Icon name={copied ? "check" : "copy"} /></button>
			{#if peer}
				<button class="iconbtn sm" onclick={reply} aria-label={t("답장")} title={t("답장")}><Icon name="reply" /></button>
			{/if}
			{#if item.seq !== null && session && item.text}
				<button class="iconbtn sm" onclick={() => app.branchEdit(session.id, item.seq!, item.text)} aria-label={t("여기서 분기해 다시 쓰기")} title={t("여기서 분기해 다시 쓰기")}>
					<Icon name="fork" />
				</button>
			{/if}
		</div>
	</div>
{:else}
	<div class="row assistant" class:fresh={parts[0]?.fresh} use:swipeable>
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
					<button class="iconbtn sm" onclick={copy} aria-label={t("답변 복사")} disabled={!plainText}><Icon name={copied ? "check" : "copy"} /></button>
					<button class="iconbtn sm" onclick={reply} aria-label={t("답장")} title={t("답장")} disabled={!plainText}><Icon name="reply" /></button>
					{#if tail.seq !== null && session && (tail.stopReason === "stop" || tail.stopReason === "length")}
						<button class="iconbtn sm" onclick={() => app.fork(session.id, tail.seq!)} aria-label={t("여기서 분기")} title={t("여기서 분기")}>
							<Icon name="fork" />
						</button>
					{/if}
					{#if canRetry}
						<button class="iconbtn sm" onclick={() => app.retry(pane.id)} aria-label={t("다시 시도")} title={t("다시 시도")}><Icon name="retry" /></button>
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
{/if}

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

	/* user */
	.row.user {
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
	}
	.bubble {
		max-width: min(85%, 560px);
		padding: 10px 15px;
		border-radius: var(--radius);
		background: var(--user-bg);
		border: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	.row.user.peer {
		align-items: flex-start;
	}
	.peerbubble {
		background: color-mix(in srgb, var(--mark-agent) 9%, var(--user-bg));
		border-color: color-mix(in srgb, var(--mark-agent) 35%, var(--border));
		border-top-left-radius: 4px;
	}
	.from {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--mark-agent);
	}
	.from :global(svg) {
		width: 14px;
		height: 14px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
	}
	.quote {
		margin: 0 0 6px;
		padding: 2px 0 2px 10px;
		border-left: 3px solid var(--border-strong);
		color: var(--text-faint);
		font-size: var(--fs-sm);
		white-space: pre-wrap;
	}
	.txt {
		white-space: pre-wrap;
	}
	.txt.clamp {
		display: -webkit-box;
		-webkit-line-clamp: 8;
		line-clamp: 8;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.tplnote {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 6px;
		font-size: 12px;
		color: var(--muted, inherit);
		opacity: 0.8;
	}
	.more {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.imgs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 2px 0 8px;
	}
	.filechips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 2px 0 8px;
	}
	.zoom {
		display: block;
		padding: 0;
		border-radius: var(--radius);
		cursor: zoom-in;
		transition: filter var(--motion-fast) var(--ease-std);
	}
	.zoom:hover {
		filter: brightness(1.08);
	}
	.imgs img {
		max-width: 100%;
		max-height: 220px;
		border-radius: var(--radius);
		display: block;
	}
	.actions {
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
		height: 24px;
		display: flex;
		align-items: flex-start;
	}
	.actions .iconbtn {
		height: 28px;
		width: 28px;
	}
	.row.user:hover .actions,
	.actions:focus-within {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.actions {
			display: none;
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
		stroke: currentColor;
		fill: none;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
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
	@media (max-width: 640px) {
		.row {
			gap: 10px;
		}
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
