<script lang="ts">
	import { t } from "../../lib/i18n";
	import Icon from "../ui/Icon.svelte";
	import TokenText from "./TokenText.svelte";
	import { app } from "../../lib/store.svelte";
	import { parsePeer } from "../../lib/peers";
	import { extensions } from "../../lib/extensions/host.svelte";
	import { queuedShown } from "../../lib/queue";

	/**
	 * A waiting message's text, the way its bubble will read: a message from another session (or a server report, or a
	 * header an extension recognises) shows its sender as a small amber label instead of the raw `[from @name, …]` line.
	 *
	 *  full  the whole text under the label (queue dialog detail); otherwise one cut line beside it (lists)
	 */
	let { text: raw, full = false }: { text: string; full?: boolean } = $props();
	const text = $derived(queuedShown(raw));
	const head = $derived(parsePeer(text) ?? extensions.headerOf(text));
	const body = $derived(head ? head.body : text);
	const server = $derived(!!head && "server" in head && !!head.server);
	const headTarget = $derived.by(() => {
		if (!full || !head || server || !head.from.startsWith("@")) return undefined;
		return app.mentionIndex.resolve(head.from);
	});
	const openHeadTarget = (e: MouseEvent) => {
		if (headTarget) app.openMention(headTarget, { direct: e.ctrlKey || e.metaKey });
	};
</script>

{#if full}
	{#if head}
		<p class="from">
			<Icon name={server ? "server" : "chat"} />
			{#if headTarget}
				<button
					type="button"
					class="from-link"
					title={headTarget.kind === "group" ? t("{name} 그룹 열기", { name: head.from }) : t("{name} 대화 미리 보기", { name: head.from })}
					onclick={openHeadTarget}
				>{head.from}</button>
			{:else}
				<span>{head.from}</span>
			{/if}
		</p>
	{/if}
	<p class="full"><TokenText text={body} sessionId={app.queueDialog} /></p>
{:else}
	<span class="line">
		{#if head}<span class="from" title={head.from}><Icon name={server ? "server" : "chat"} /><span class="who">{head.from}</span></span>{/if}
		<span class="qt">{body}</span>
	</span>
{/if}

<style>
	.line {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	/* The sender in the bubble's peer colour, so a queued peer message reads like the bubble it becomes. */
	.from {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
		max-width: 40%;
		margin: 0;
		font-weight: 600;
		color: var(--mark-header);
	}
	.from :global(svg) {
		width: 12px;
		height: 12px;
		stroke-width: 2;
	}
	.who {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.from-link {
		font: inherit;
		color: inherit;
		text-underline-offset: 3px;
	}
	@media (hover: hover) {
		.from-link:hover {
			text-decoration: underline;
		}
	}
	.qt {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Detail view: the label on its own line above the whole text, like the bubble header. */
	p.from {
		display: flex;
		max-width: none;
		margin: 0 0 4px;
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	p.from :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.8;
	}
	/* The whole message as it will be sent: line breaks kept, long words and paths wrapped instead of widening the dialog. */
	.full {
		margin: 0;
		font-size: var(--fs-md);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		user-select: text;
	}
</style>
