<script lang="ts">
	import IconButton from "../ui/IconButton.svelte";
	import { t } from "../../lib/i18n";
	import { fullTime } from "../../lib/format";
	import { liveMessageTime } from "../../lib/minute-clock.svelte";
	import { parsePeer } from "../../lib/peers";
	import Icon from "../ui/Icon.svelte";
	import FileChip from "./FileChip.svelte";
	import TokenText from "./TokenText.svelte";
	import { app } from "../../lib/store.svelte";
	import { reveal } from "../../lib/reveal.svelte";
	import { tapTitle } from "../../lib/touch-hints";
	import { CopyFlag } from "../../lib/copy-flag.svelte";
	import { onDestroy } from "svelte";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { splitQuote } from "../../lib/quote";
	import type { Session, UserItem } from "../../lib/types";

	/**
	 * What the user sent: attached pictures and files, who it came from when another session sent it, a quoted answer,
	 * the text (an extension command's note can fold it), and copy / reply / branch buttons under the bubble.
	 *
	 *  working  this is the prompt the agent is busy answering (the bubble glows in the model's thinking colour)
	 *  glow     that colour's level, when the model reasons
	 */
	let {
		item,
		session,
		working = false,
		level,
		onreply,
	}: { item: UserItem; session: Session | undefined; working?: boolean; level?: string; onreply: (text: string, who?: string) => void } = $props();

	/** Set when an extension recognises the first line of the message (`sdk.messages.setHeader`): a label for where it came from. */
	const header = $derived(parsePeer(item.text) ?? extensions.headerOf(item.text));
	/** When the header names another active session/group (`@name`), clicking it jumps straight to that chat. */
	const headerTarget = $derived.by(() => {
		if (!header || ("server" in header && header.server) || !header.from.startsWith("@")) return undefined;
		return app.mentionIndex.resolve(header.from);
	});
	const openHeaderTarget = () => {
		if (headerTarget) app.openMention(headerTarget);
	};
	/** A prompt a scheduled task sent: the bubble is labelled "예약" like a message from another session is labelled with its sender. */
	const scheduled = $derived(!!item.scheduled && !header);
	const shown = $derived(splitQuote(header ? header.body : item.text));
	const copied = new CopyFlag();
	onDestroy(() => copied.dispose());
	let expanded = $state(false);
</script>

<!-- a tap shows this message's buttons on a touch screen (reveal.svelte.ts); the buttons themselves are reachable on their own -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="row user" data-part="message.user" class:headed={!!header || scheduled} class:fresh={item.fresh} class:shown={reveal.key === item.key} onclick={(e) => reveal.tap(e, item.key)}>
	<div class="bubble" data-part="message.user.bubble" class:headedbubble={!!header || scheduled} class:scheduled class:glow-working={working} data-level={working ? level : undefined}>
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
		{#if header}
			<div class="header">
				<Icon name={"server" in header && header.server ? "server" : "chat"} />
				{#if headerTarget}
					<button
						type="button"
						class="header-link"
						title={headerTarget.kind === "group" ? t("{name} 그룹 열기", { name: header.from }) : t("{name} 대화 열기", { name: header.from })}
						onclick={openHeaderTarget}
					>{header.from}</button>
				{:else}
					<span>{header.from}</span>
				{/if}
			</div>
		{:else if scheduled}
			<div class="header">
				<Icon name="clock" />
				{#if session}
					<button type="button" class="header-link" title={t("예약 작업 보기")} onclick={() => app.openScheduleFor(session.id)}>{t("예약")}</button>
				{:else}
					<span>{t("예약")}</span>
				{/if}
			</div>
		{/if}
		{#if shown.quote}
			<blockquote class="quote"><TokenText text={shown.quote} sessionId={session?.id ?? null} /></blockquote>
		{/if}
		{#if shown.rest}
			<div class="txt" class:clamp={item.note?.collapse && !expanded}><TokenText text={shown.rest} images={item.images} skills={item.skills ?? []} sessionId={session?.id ?? null} /></div>
		{/if}
		{#if item.note}
			{@const call = item.note.call ?? ""}
			<div class="tplnote">
				{#if call.startsWith("/prompt:")}
					<button type="button" class="notelink" title={t("프롬프트 {name} 보기", { name: call.slice(8).split(/\s/, 1)[0] ?? "" })} onclick={() => app.openTemplates(session?.id ?? null)}>{item.note.text}</button>
				{:else if /^\/[a-z][a-z0-9-]*:/.test(call)}
					<button type="button" class="notelink" title={t("확장 명령 보기")} onclick={() => app.openCommands(session?.id ?? null)}>{item.note.text}</button>
				{:else}
					<span title={call} use:tapTitle>{item.note.text}</span>
				{/if}
				{#if item.note.collapse && (item.text.length > 400 || item.text.split("\n").length > 8)}
					<button class="more" onclick={() => (expanded = !expanded)}>{expanded ? t("접기") : t("더 보기")}</button>
				{/if}
			</div>
		{/if}
	</div>
	<div class="actions">
		<IconButton icon={copied.done ? "check" : "copy"} label={t("메시지 복사")} size="sm" onclick={() => void copied.copy(item.text, item.images)} />
		{#if header && !("server" in header && header.server)}
			<IconButton icon="reply" label={t("답장")} tip size="sm" onclick={() => onreply(header.body, header.from)} />
		{/if}
		{#if item.seq !== null && session && item.text}
			<IconButton icon="fork" label={t("여기서 분기해 다시 쓰기")} tip size="sm" onclick={() => app.branchEdit(session.id, item.seq!, item.text)} />
		{/if}
		{#if item.ts}<time class="when" use:tapTitle datetime={new Date(item.ts).toISOString()} title={fullTime(item.ts)}>{liveMessageTime(item.ts)}</time>{/if}
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

	/* user */
	.row.user {
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
	}
	.bubble {
		max-width: min(85%, 560px);
		padding: 8px 16px;
		border-radius: var(--radius);
		background: var(--user-bg);
		border: 1px solid var(--border);
		overflow-wrap: anywhere;
		text-wrap: pretty; /* a sent message never changes, so avoid leaving one short word alone on the last line */
	}
	.row.user.headed {
		align-items: flex-start;
	}
	/* Peer messages are tinted amber, prompts from a scheduled task blue, so the two read apart at a glance. */
	.headedbubble {
		--tint: var(--mark-header);
		background: color-mix(in srgb, var(--tint) 9%, var(--user-bg));
		border-color: color-mix(in srgb, var(--tint) 35%, var(--border));
		border-top-left-radius: var(--radius-xs);
	}
	.headedbubble.scheduled {
		--tint: var(--info);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-bottom: 4px;
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px;
		color: var(--tint);
	}
	.header :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.8;
	}
	.header-link {
		font: inherit;
		color: inherit;
		text-underline-offset: 3px;
	}
	@media (hover: hover) {
		.header-link:hover {
			text-decoration: underline;
		}
	}
	.quote {
		margin: 0 0 4px;
		padding: 4px 0 4px 8px;
		border-left: 3px solid var(--border-strong);
		color: var(--text-faint);
		font-size: var(--fs-sm);
		white-space: pre-wrap;
	}
	.txt {
		white-space: pre-wrap;
		line-height: 24px; /* whole-pixel line box (vs body's 23.25px) so inline chips do not snap by 1px at fractional DPR */
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
		margin-top: 4px;
		font-size: 12px;
		line-height: 16px;
		color: var(--muted, inherit);
		opacity: 0.8;
	}
	.more,
	.notelink {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.more {
		text-decoration: underline;
	}
	.notelink {
		text-decoration: underline;
		text-decoration-style: dotted;
		text-underline-offset: 3px;
	}
	.notelink:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: var(--radius-xs);
	}
	@media (hover: hover) {
		.notelink:hover {
			text-decoration-style: solid;
		}
	}
	.imgs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 4px 0 8px;
	}
	.filechips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 4px 0 8px;
	}
	.zoom {
		display: block;
		padding: 0;
		border-radius: var(--radius);
		cursor: zoom-in;
	}
	.imgs img {
		max-width: 100%;
		max-height: 220px;
		border-radius: var(--radius);
		display: block;
	}
	/* the same 32px row as the answer's foot (one height for every action row), right-aligned on the content's right line:
	   the box ends 2px past where the answer's text ends, and the 6px bleed puts the last glyph on that line */
	.actions {
		height: 32px;
		display: flex;
		align-items: center;
		gap: 0;
		/* 8px glyph inset less the 2px the last box is pulled in: the last glyph's right edge lands on the content's right edge */
		margin-right: -6px;
	}
	/* when it was sent, last in the row so it ends on the bubble's right line whether or not the buttons show: the row
	   bleeds 6px for a last glyph (below), which the time takes back; 8px from the glyph before it (its box bleeds 2px) */
	.when {
		margin-left: 6px;
		margin-right: 6px;
		font-size: var(--fs-2xs);
		line-height: 20px;
		color: var(--text-faint);
		white-space: nowrap;
	}
	/* a message from another session or a scheduled task sits on the left: the row mirrors the answer's foot, the time
	   first on the bubble's left line and the buttons after it, so the hidden buttons no longer push the time inwards */
	.row.user.headed .actions {
		margin-right: 0;
	}
	.row.user.headed .when {
		order: -1;
		margin-left: 0;
		margin-right: 4px; /* the next box overlaps 2px and holds its 14px glyph 9px in: 11px to the ink, as the answer's stats */
	}
	/* copy / reply / branch are lighter than the app's other buttons: a 14px glyph at 1.75 in the time's faint colour,
	   so they read as part of the time's line instead of three dark marks after it (16px at stroke 2 did). Hover brings the text colour */
	.actions :global(.iconbtn) {
		color: var(--text-faint);
	}
	.actions :global(.iconbtn svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.75;
	}
	@media (hover: hover) {
		.actions :global(.iconbtn:hover:not(:disabled)) {
			color: var(--text);
		}
	}
	/* same 28px pitch as the answer's foot: 32px boxes overlapping 2px, so the 16px glyphs do not read 20px apart */
	.actions :global(.iconbtn) {
		margin-inline: -2px;
	}
	/* only the buttons wait for the hover: the time stays readable, as the answer's stats line does */
	.actions :global(.iconbtn) {
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	/* the buttons are IconButton's markup: `:global`, or the compiler drops the rule and Tab never reveals them */
	.actions:has(:global(:focus-visible)) :global(.iconbtn) {
		opacity: 1;
	}
	/* hover only where it is a real pointer: a tap leaves :hover stuck on the row (see AssistantMessage) */
	@media (hover: hover) {
		.row.user:hover .actions :global(.iconbtn) {
			opacity: 1;
		}
	}
	/* no hover on a phone: a tap on the message shows its buttons (the answer's do the same); hidden ones take no taps */
	@media (pointer: coarse) {
		.actions :global(.iconbtn) {
			pointer-events: none;
		}
		.row.user.shown .actions :global(.iconbtn) {
			opacity: 1;
			pointer-events: auto;
		}
	}
</style>
