<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { sessionTitle } from "../../lib/session-title";
	import { activityOf, ACTIVITY_LABEL } from "../../lib/activity";
	import Modal from "../ui/Modal.svelte";
	import Icon from "../ui/Icon.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";
	import Pane from "../shell/Pane.svelte";

	/**
	 * A chat looked at from the graph view without leaving it: the conversation itself (the same pane as the main view,
	 * with its transcript, input and status line) in a large dialog, a bottom sheet on a phone. The chat is opened on its
	 * server the usual way (`app.peekChat`) while the graph stays up; closing the graph goes back to where the user came
	 * from. "대화 열기" leaves the graph for the chat.
	 */
	let { server, session, onclose }: { server: string; session: string; onclose: () => void } = $props();

	const link = $derived(app.links[server]);
	const s = $derived(link?.sessionById.get(session));
	const activity = $derived(link ? activityOf(link.data, session) : "idle");
	/** The pane appears once the chat's server is the open one and the chat is its active one. */
	const ready = $derived(app.serverId === server && app.activeId === session);
	const sub = $derived(
		[app.servers.find((x) => x.id === server)?.name ?? server, s?.name ? `@${s.name}` : "", s?.cwd.split("/").slice(-2).join("/") ?? ""].filter(Boolean).join(" · "),
	);

	/** Leave the graph for this chat (not back to where the graph was opened from). */
	function openChat() {
		app.graphFrom = null;
		onclose();
		app.openIn(server, { session });
	}
</script>

<!-- Large on a desktop (most of the window, up to a comfortable reading width); the usual 90% sheet on a phone -->
<Modal {onclose} label={sessionTitle(s?.title)} title={sessionTitle(s?.title)} {sub} subMono width="min(1080px, calc(var(--vw) * 0.8))" height="calc(var(--dvh) * 0.86)" maxHeight="1000px" divider>
	{#snippet headerActions()}
		<span class="st" title={ACTIVITY_LABEL[activity]}><AgentBadge id={session} {server} state={activity} size={16} /></span>
		<button class="open" onclick={openChat} title={t("대화 열기")}><Icon name="arrow-right" /><span class="lbl">{t("대화 열기")}</span></button>
	{/snippet}
	<div class="quick">
		{#if ready}
			<Pane id={session} />
		{:else}
			<p class="note">{t("불러오는 중…")}</p>
		{/if}
	</div>
</Modal>

<style>
	.quick {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg); /* the chat's own surface, under the dialog's header */
		container-type: inline-size;
	}
	.quick > :global(.pane) {
		flex: 1;
		min-height: 0;
	}
	.note {
		margin: auto;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.st {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
	}
	.open {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 16px;
	}
	.open :global(.ic) {
		font-size: 16px;
	}
	@media (hover: hover) {
		.open:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	@media (max-width: 480px) {
		.open .lbl {
			display: none;
		}
		.open {
			width: 32px;
			padding: 0;
		}
	}
</style>
