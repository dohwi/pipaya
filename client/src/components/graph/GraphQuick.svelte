<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { errorText } from "../../lib/api";
	import { ChatState } from "../../lib/chat.svelte";
	import { sessionTitle } from "../../lib/session-title";
	import { activityOf, ACTIVITY_LABEL } from "../../lib/activity";
	import { toolSummary } from "../../lib/tools";
	import { setPane } from "../../lib/pane";
	import { viewport } from "../../lib/viewport.svelte";
	import Modal from "../ui/Modal.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import MessageList from "../chat/MessageList.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";

	/**
	 * A chat looked at from the graph view without leaving it, drawn exactly as its own pane draws it (the same message
	 * list, replies, work boxes and tool cards) in a large dialog, a bottom sheet on a phone. It works for a chat on any
	 * saved server: the transcript is a ChatState of its own, loaded from that server and fed by that server's stream
	 * (`app.graphPeek`). The input below is the composer's box: Enter sends; while the agent works, Enter steers into the
	 * running turn and Alt+Enter queues for after it. What acts through the open server (reply, retry, branch, answer
	 * a question) is left to the chat itself: "대화 열기".
	 */
	let { server, session, onclose }: { server: string; session: string; onclose: () => void } = $props();

	const link = $derived(app.links[server]);
	const s = $derived(link?.sessionById.get(session));
	const activity = $derived(link ? activityOf(link.data, session) : "idle");
	const running = $derived(!!link?.data.running[session]);
	const queued = $derived(link?.data.queued[session] ?? []);
	const tool = $derived(link?.data.tool[session]);

	/** One transcript per opening; a card switched to while open (the dialog is keyed by chat) gets a fresh one. */
	const chat = untrack(() => {
		const api = app.links[server]?.api;
		if (!api) return null;
		const c = new ChatState(session, api);
		app.graphPeek = { server, chat: c };
		void c.load();
		return c;
	});
	onDestroy(() => {
		if (app.graphPeek?.chat === chat) app.graphPeek = null;
	});
	// the message list and its cards read this transcript instead of the open server's
	setPane(() => ({ id: session, focused: true, peek: chat ?? undefined }));

	// ---- writing ----
	let text = $state("");
	let sending = $state(false);
	let sendError = $state("");
	async function send(queue: boolean) {
		const body = text.trim();
		const api = link?.api;
		if (!body || !api || sending) return;
		sending = true;
		sendError = "";
		try {
			// the server decides by whether a run is going: steer / follow_up join it, a prompt starts one
			chat?.requestBottom();
			await api.send(session, body, running ? (queue ? "follow_up" : "steer") : "prompt");
			text = "";
		} catch (e) {
			sendError = errorText(e); // the text stays, to send again
		} finally {
			sending = false;
		}
	}
	function keydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void send(e.altKey);
		}
	}
	async function stop() {
		try {
			await link?.api.abort(session);
		} catch (e) {
			sendError = errorText(e);
		}
	}
	const hint = $derived(running ? t("Enter 끼워 넣기 · Alt+Enter 대기열 · Shift+Enter 줄바꿈") : t("Enter 보내기 · Shift+Enter 줄바꿈"));
	const sub = $derived([link ? (app.servers.find((x) => x.id === server)?.name ?? server) : "", s?.name ? `@${s.name}` : "", s?.cwd.split("/").slice(-2).join("/") ?? "", s?.model ?? ""].filter(Boolean).join(" · "));
	let input: HTMLTextAreaElement | undefined = $state();
	$effect(() => {
		// ready to type (not on a phone, where the keyboard would cover the transcript)
		if (!viewport.narrow) input?.focus({ preventScroll: true });
	});

	function openChat() {
		onclose();
		app.openIn(server, { session });
	}
</script>

<!-- Large on a desktop (most of the window, up to a comfortable reading width); the usual 90% sheet on a phone -->
<Modal {onclose} label={sessionTitle(s?.title)} title={sessionTitle(s?.title)} {sub} subMono width="min(1080px, calc(var(--vw) * 0.8))" height="calc(var(--dvh) * 0.86)" maxHeight="1000px" divider>
	{#snippet headerActions()}
		<button class="open" onclick={openChat} title={t("대화 열기")}><Icon name="arrow-right" /><span class="lbl">{t("대화 열기")}</span></button>
	{/snippet}
	<div class="quick">
		<div class="state">
			<AgentBadge id={session} {server} state={activity} size={16} />
			<span class="what">
				{#if activity === "working"}{tool ? `${tool.name} ${toolSummary(tool.name, tool.args)}` : t("생각 중")}
				{:else if activity === "asking"}{t("답을 기다립니다")}
				{:else if activity === "failed"}{t("마지막 작업이 실패했습니다")}
				{:else}{ACTIVITY_LABEL[activity]}{/if}
			</span>
			{#if queued.length}<span class="q">{t("대기 중인 메시지 {n}개", { n: queued.length })}</span>{/if}
		</div>
		<!-- the chat pane's own transcript: same width, bubbles, replies, work boxes and tool cards -->
		<div class="list">
			{#if chat}<MessageList {chat} />{:else}<p class="note">{t("연결 안 됨")}</p>{/if}
		</div>
		<!-- the composer's box, without what belongs to the open server's composer (attachments, model, commands) -->
		<div class="wrap">
			<div class="box" class:glow-working={running} class:disabled={!link?.online}>
				<textarea bind:this={input} bind:value={text} onkeydown={keydown} rows="1" placeholder={running ? t("작업 중인 에이전트에게 끼워 넣기") : t("에이전트에게 메시지 보내기")} aria-label={t("메시지")} disabled={!link?.online}></textarea>
				<div class="bar">
					<span class="hint" class:bad={!!sendError}>{sendError || hint}</span>
					{#if running}
						<IconButton icon="stop" label={t("중지")} tip class="stopbtn" onclick={stop} />
					{/if}
					<button class="send" onclick={() => send(false)} disabled={!text.trim() || sending || !link?.online} aria-label={running ? t("끼워 넣기") : t("보내기")} title={running ? t("끼워 넣기") : t("보내기")}><Icon name={running ? "bolt" : "arrow-up"} /></button>
				</div>
			</div>
		</div>
	</div>
</Modal>

<style>
	.quick {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg); /* the chat's own surface, under the dialog's header */
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
	.state {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px var(--dlg-px);
		border-bottom: 1px solid var(--border);
		background: var(--bg-side);
		font-size: var(--fs-xs);
		line-height: 16px;
		color: var(--text-dim);
	}
	.state .what {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.state .q {
		flex: none;
		color: var(--text-faint);
	}
	/* the pane's list box: MessageList scrolls inside it and keeps its own reading width */
	.list {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
		container-type: inline-size;
	}
	.note {
		margin: auto;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	/* the composer's wrap and box: the same width, radius, border, focus ring and working glow */
	.wrap {
		flex: none;
		width: 100%;
		max-width: calc(var(--content-w) + 32px);
		margin: 0 auto;
		padding: 0 16px calc(16px + var(--sab));
	}
	.box {
		position: relative;
		border: 1px solid var(--border-strong);
		border-radius: 22px;
		background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std),
			opacity var(--motion-fast) var(--ease-std);
	}
	.box:focus-within {
		border-color: var(--text-faint);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	.box.glow-working {
		--glow-base: var(--border-strong);
	}
	.box.disabled {
		opacity: 0.6;
	}
	textarea {
		display: block;
		width: 100%;
		min-height: 28px;
		max-height: 220px;
		padding: 12px 16px 4px;
		border: 0;
		outline: 0;
		background: transparent;
		resize: none;
		font: inherit;
		font-size: var(--fs-lg);
		line-height: 1.5;
		color: var(--text);
		field-sizing: content;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px 8px 16px;
	}
	.hint {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.hint.bad {
		color: var(--danger);
	}
	.send {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 18px;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.send:disabled {
		opacity: 0.35;
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
