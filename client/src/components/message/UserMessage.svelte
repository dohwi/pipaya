<script lang="ts">
	import IconButton from "../IconButton.svelte";
	import { t } from "../../lib/i18n";
	import Icon from "../Icon.svelte";
	import FileChip from "../FileChip.svelte";
	import { app } from "../../lib/store.svelte";
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
	const header = $derived(extensions.headerOf(item.text));
	const shown = $derived(splitQuote(header ? header.body : item.text));
	const copied = new CopyFlag();
	onDestroy(() => copied.dispose());
	let expanded = $state(false);
</script>

<div class="row user" data-part="message.user" class:headed={!!header} class:fresh={item.fresh}>
	<div class="bubble" class:headedbubble={!!header} class:glow-working={working} data-level={working ? level : undefined}>
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
			<div class="header"><Icon name="chat" /> <span>{header.from}</span></div>
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
		<IconButton icon={copied.done ? "check" : "copy"} label={t("메시지 복사")} size="sm" onclick={() => void copied.copy(item.text)} />
		{#if header}
			<IconButton icon="reply" label={t("답장")} tip size="sm" onclick={() => onreply(header.body, header.from)} />
		{/if}
		{#if item.seq !== null && session && item.text}
			<IconButton icon="fork" label={t("여기서 분기해 다시 쓰기")} tip size="sm" onclick={() => app.branchEdit(session.id, item.seq!, item.text)} />
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
	.row.user.headed {
		align-items: flex-start;
	}
	.headedbubble {
		background: color-mix(in srgb, var(--mark-header) 9%, var(--user-bg));
		border-color: color-mix(in srgb, var(--mark-header) 35%, var(--border));
		border-top-left-radius: 4px;
	}
	.header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--mark-header);
	}
	.header :global(svg) {
		width: 14px;
		height: 14px;
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
	.actions :global(.iconbtn) {
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
</style>
