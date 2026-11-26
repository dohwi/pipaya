<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { sessionTitle } from "../../lib/session-title";
	import { workDir } from "../../lib/nav";
	import { activityOf, ACTIVITY_LABEL } from "../../lib/activity";
	import Modal from "../ui/Modal.svelte";
	import Icon from "../ui/Icon.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import Pane from "./Pane.svelte";

	/**
	 * A conversation peeked in a large dialog (90% bottom sheet on a phone) without leaving the current screen:
	 *  - `mode="chat"`: opened from a `@session` mention chip over the current chat/group pane without mutating `activeId`.
	 *  - `mode="graph"`: opened from a session card in the graph view while the graph stays up underneath (`app.peekChat`).
	 * Clicking "대화 열기" navigates to the full session view.
	 */
	let {
		server,
		session,
		mode = "chat",
		onclose,
	}: { server: string; session: string; mode?: "chat" | "graph"; onclose: () => void } = $props();

	const link = $derived(app.links[server]);
	const s = $derived(link?.sessionById.get(session));
	const activity = $derived(link ? activityOf(link.data, session) : "idle");
	/** In graph mode the pane waits until `peekChat` activates its server/session; in chat mode the session is already on the open server. */
	const ready = $derived(
		mode === "graph"
			? app.serverId === server && app.activeId === session
			: app.serverId === server && !!app.session(session),
	);
	const sub = $derived(
		[
			mode === "graph" || app.servers.length > 1 ? (app.servers.find((x) => x.id === server)?.name ?? server) : "",
			s?.name ? `@${s.name}` : "",
			s ? workDir(s).split(/[\\/]/).slice(-2).join("/") : "",
		]
			.filter(Boolean)
			.join(" · "),
	);

	let closingId: string | null = null;
	/** Close this conversation (same as Ctrl+D in the main view); the store closes the modal when it succeeds. */
	async function closeChat() {
		const target = session;
		const targetServer = server;
		if (closingId === target) return;
		closingId = target;
		try {
			await app.close(target, false, targetServer);
		} finally {
			if (closingId === target) closingId = null;
		}
	}

	/** Leave the modal (and graph, if open) and navigate straight to this conversation. */
	function openChat() {
		// read props first: closing clears the store's peek state, and props may derive from it
		const to = { server, session };
		if (mode === "graph") {
			app.graphFrom = null;
			onclose();
			app.openIn(to.server, { session: to.session });
		} else {
			onclose();
			void app.openAny(to.session);
		}
	}
</script>

<!-- Large on a desktop (most of the window, up to a comfortable reading width); the usual 90% sheet on a phone -->
<Modal {onclose} closeShortcut="closeSession" onshortcutclose={() => void closeChat()} label={sessionTitle(s?.title)} title={sessionTitle(s?.title)} {sub} subMono width="min(var(--modal-w-3xl), calc(var(--vw) * 0.8))" height="calc(var(--dvh) * 0.86)" maxHeight="1000px" divider quick>
	{#snippet headerLead()}
		<span class="st" title={ACTIVITY_LABEL[activity]}><AgentBadge id={session} {server} state={activity} size={24} /></span>
	{/snippet}
	{#snippet headerActions()}
		<button class="open tap" onclick={openChat} aria-label={t("대화 열기")} title={t("대화 열기")}><Icon name="arrow-right" /><span class="lbl">{t("대화 열기")}</span></button>
	{/snippet}
	<div class="quick">
		{#if ready}
			{#key `${server}/${session}`}
				<Pane id={session} peek />
			{/key}
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
		width: 24px;
		height: 24px; /* the agent's mark beside a two-line title, the size the graph's chat card shows it */
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
			width: 38px;
			height: 38px;
			padding: 0;
			border-radius: 50%; /* the sibling ModalHeader close button: a 38px circle with a 19px glyph */
		}
		.open :global(.ic) {
			font-size: 19px;
		}
	}
</style>
