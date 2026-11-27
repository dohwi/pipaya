<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { sessionTitle } from "../../lib/session-title";
	import { workDir } from "../../lib/nav";
	import { activityOf, ACTIVITY_LABEL } from "../../lib/activity";
	import { hideMentionHover } from "../../lib/mention-hover.svelte";
	import Modal from "../ui/Modal.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import AgentBadge from "./AgentBadge.svelte";
	import Pane from "./Pane.svelte";
	import ReadonlyPane from "./ReadonlyPane.svelte";

	/**
	 * A conversation peeked in a large dialog (90% bottom sheet on a phone) without leaving the current screen:
	 *  - `mode="chat"`: opened from a `@session` mention chip over the current chat/group pane without mutating `activeId`.
	 *    Open sessions on the current server mount a live `<Pane>`; closed or remote-server sessions mount `<ReadonlyPane>`.
	 *  - `mode="graph"`: opened from a session card in the graph view while the graph stays up underneath (`app.peekChat`).
	 * Clicking "대화 열기" / "다시 열기" navigates to the full session view.
	 */
	let {
		server,
		session,
		mode = "chat",
		onclose,
	}: { server: string; session: string; mode?: "chat" | "graph"; onclose: () => void } = $props();

	const link = $derived(app.links[server]);
	const s = $derived(app.sessionAny(session, server));
	const isClosed = $derived(Boolean(s?.closed));
	const isReadonly = $derived(isClosed || (mode === "chat" && server !== app.serverId));
	const activity = $derived(!isClosed && link ? activityOf(link.data, session) : "idle");
	/** In graph mode a live pane waits until `peekChat` activates its server/session; in chat mode it is already on the open server. */
	const ready = $derived(
		isReadonly
			? Boolean(link && s)
			: mode === "graph"
				? app.serverId === server && app.activeId === session
				: app.serverId === server && !!app.session(session),
	);
	const sub = $derived(
		[
			mode === "graph" || server !== app.serverId || app.servers.length > 1
				? (app.servers.find((x) => x.id === server)?.name ?? server)
				: "",
			s?.name ? `@${s.name}` : "",
			isClosed ? t("닫힘") : "",
			s ? workDir(s).split(/[\\/]/).slice(-2).join("/") : "",
		]
			.filter(Boolean)
			.join(" · "),
	);

	const history = $derived(mode === "graph" ? app.graphPeekHistory : app.chatPeekHistory);
	const prevEntry = $derived(history.length ? history[history.length - 1] : null);
	const prevLabel = $derived.by(() => {
		if (!prevEntry) return "";
		const ps = app.sessionAny(prevEntry.session, prevEntry.server);
		if (!ps) return "";
		return ps.name ? `@${ps.name}` : sessionTitle(ps.title);
	});

	function goBack() {
		hideMentionHover();
		if (mode === "graph") app.graphPeekBack();
		else app.chatPeekBack();
	}

	function onKeyDown(e: KeyboardEvent) {
		if (!history.length || e.isComposing) return;
		const target = e.target as HTMLElement | null;
		if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
			return;
		}
		if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "ArrowLeft") {
			e.preventDefault();
			e.stopPropagation();
			goBack();
		}
	}

	let closingId: string | null = null;
	/** Close this conversation (same as Ctrl+D in the main view); the store closes the modal when it succeeds. */
	async function closeChat() {
		if (isReadonly) return;
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

	/** Leave the modal (and graph, if open) and navigate straight to this conversation (resuming if closed). */
	function openChat() {
		hideMentionHover();
		// read props first: closing clears the store's peek state, and props may derive from it
		const to = { server, session };
		if (mode === "graph") {
			app.graphFrom = null;
			onclose();
			void app.openAnyOn(to.server, to.session);
		} else {
			onclose();
			void app.openAnyOn(to.server, to.session);
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- Large on a desktop (most of the window, up to a comfortable reading width); the usual 90% sheet on a phone -->
<Modal {onclose} closeShortcut={isReadonly ? undefined : "closeSession"} onshortcutclose={() => void closeChat()} label={sessionTitle(s?.title)} title={sessionTitle(s?.title)} {sub} subMono width="min(var(--modal-w-3xl), calc(var(--vw) * 0.8))" height="calc(var(--dvh) * 0.86)" maxHeight="1000px" divider quick>
	{#snippet headerLead()}
		<span class="lead-row">
			{#if history.length > 0}
				<IconButton
					icon="arrow-left"
					size="sm"
					label={prevLabel ? t("이전 대화 ({name})", { name: prevLabel }) : t("이전 대화")}
					tip
					onclick={goBack}
				/>
			{/if}
			<span class="st" title={isClosed ? t("닫힘") : ACTIVITY_LABEL[activity]}><AgentBadge id={session} {server} state={activity} size={24} /></span>
		</span>
	{/snippet}
	{#snippet headerActions()}
		<button class="open tap" onclick={openChat} aria-label={isClosed ? t("다시 열기") : t("대화 열기")} title={isClosed ? t("다시 열기") : t("대화 열기")}>
			<Icon name={isClosed ? "undo" : "arrow-right"} />
			<span class="lbl">{isClosed ? t("다시 열기") : t("대화 열기")}</span>
		</button>
	{/snippet}
	<div class="quick">
		{#if ready}
			{#key `${server}/${session}`}
				{#if isReadonly}
					<ReadonlyPane {server} {session} closed={isClosed} onopen={openChat} />
				{:else}
					<Pane id={session} peek />
				{/if}
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
	.lead-row {
		display: inline-flex;
		align-items: center;
		gap: 4px;
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
