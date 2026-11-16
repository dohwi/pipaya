<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { errorText, type StoredMessage } from "../../lib/api";
	import { sessionTitle } from "../../lib/session-title";
	import { activityOf } from "../../lib/activity";
	import { toolSummary } from "../../lib/tools";
	import { quickItems, type QuickItem } from "../../lib/graph-quick";
	import { viewport } from "../../lib/viewport.svelte";
	import Modal from "../ui/Modal.svelte";
	import Icon from "../ui/Icon.svelte";
	import QuickWork from "./QuickWork.svelte";
	import Markdown from "../chat/Markdown.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";

	/**
	 * A chat looked at from the graph view without leaving it, in a large dialog (a bottom sheet on a phone): its newest
	 * messages, the tool calls as work boxes, and an input. While the agent works,
	 * Enter steers (goes into the running turn) and Alt+Enter queues for after it; when idle, Enter starts a turn.
	 * "대화 열기" goes to the chat itself.
	 */
	let { server, session, onclose }: { server: string; session: string; onclose: () => void } = $props();

	const link = $derived(app.links[server]);
	const s = $derived(link?.sessionById.get(session));
	const activity = $derived(link ? activityOf(link.data, session) : "idle");
	const running = $derived(!!link?.data.running[session]);
	const queued = $derived(link?.data.queued[session] ?? []);
	const tool = $derived(link?.data.tool[session]);

	/**
	 * The newest stored messages, folded into what the panel draws. They are kept raw, and new ones appended, so a tool
	 * result that arrives later finds its call; the window is cut at a user message so no reply starts mid-way.
	 */
	const TAIL = 120;
	let raw: StoredMessage[] = [];
	let items = $state<QuickItem[]>([]);
	let loading = $state(true);
	let error = $state("");
	const lastSeq = () => raw.at(-1)?.seq ?? -1;
	const keep = (ms: StoredMessage[]) => {
		let cut = Math.max(0, ms.length - TAIL);
		while (cut > 0 && cut < ms.length && (ms[cut]!.message as { role: string }).role !== "user") cut++;
		raw = cut >= ms.length ? ms.slice(-TAIL) : ms.slice(cut);
		items = quickItems(raw);
	};

	async function load(api: NonNullable<typeof link>["api"], id: string) {
		try {
			const ms = await api.tailMessages(id, TAIL);
			if (id !== session) return;
			keep(ms);
			error = "";
		} catch (e) {
			if (id === session) error = errorText(e);
		} finally {
			if (id === session) loading = false;
		}
	}
	/** Only what came after the newest message shown. */
	async function more(api: NonNullable<typeof link>["api"], id: string) {
		if (lastSeq() < 0) return load(api, id);
		try {
			const ms = await api.messages(id, lastSeq());
			if (id !== session || !ms.length) return;
			keep([...raw, ...ms]);
		} catch {
			/* the next tick tries again */
		}
	}
	$effect(() => {
		// a new chat (another card clicked): start over
		const api = link?.api;
		const id = session;
		raw = [];
		items = [];
		loading = true;
		error = "";
		stuck = true;
		if (!api) return;
		void load(api, id);
		const tick = setInterval(() => void more(api, id), 1500);
		return () => clearInterval(tick);
	});

	let list: HTMLDivElement | undefined = $state();
	let stuck = true;
	$effect(() => {
		void items;
		if (list && stuck) requestAnimationFrame(() => list && (list.scrollTop = list.scrollHeight));
	});
	/** The work box the agent is on: the last one, while it runs and nothing it said came after it. */
	const liveWork = $derived(running && items.at(-1)?.kind === "work" ? items.at(-1)!.key : null);


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
			await api.send(session, body, running ? (queue ? "follow_up" : "steer") : "prompt");
			text = "";
			stuck = true;
			void more(api, session);
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
	const hint = $derived(running ? t("Enter 끼워 넣기 · Alt+Enter 대기열 · Shift+Enter 줄바꿈") : t("Enter 보내기 · Shift+Enter 줄바꿈"));
	const sub = $derived([link ? (app.servers.find((x) => x.id === server)?.name ?? server) : "", s?.name ? `@${s.name}` : "", s?.cwd.split("/").slice(-2).join("/") ?? "", s?.model ?? ""].filter(Boolean).join(" · "));
	let input: HTMLTextAreaElement | undefined = $state();
	$effect(() => {
		// a new chat in the panel: ready to type (not on a phone, where the keyboard would cover it)
		void session;
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
				{#if activity === "asking"}{t("답을 기다립니다")}
				{:else if activity === "working"}{tool ? `${tool.name} ${toolSummary(tool.name, tool.args)}` : t("생각 중")}
				{:else if activity === "failed"}{t("마지막 작업이 실패했습니다")}
				{:else if activity === "done"}{t("작업 완료")}
				{:else}{t("대기")}{/if}
			</span>
			{#if queued.length}<span class="q">{t("대기 중인 메시지 {n}개", { n: queued.length })}</span>{/if}
		</div>
		<div class="list" bind:this={list} onscroll={() => list && (stuck = list.scrollHeight - list.scrollTop - list.clientHeight < 24)}>
			{#if loading}
				<p class="note">{t("불러오는 중…")}</p>
			{:else if error}
				<p class="note bad">{error}</p>
			{:else if !items.length}
				<p class="note">{t("아직 메시지가 없습니다")}</p>
			{/if}
			{#each items as it (it.key)}
				{#if it.kind === "work"}
					<QuickWork steps={it.steps} live={it.key === liveWork} />
				{:else if it.kind === "user"}
					<div class="msg user"><div class="bubble">{it.text}</div></div>
				{:else}
					<div class="msg agent"><Markdown text={it.text} sessionId={null} /></div>
				{/if}
			{/each}
		</div>
		<div class="write">
			<div class="box">
				<textarea bind:this={input} bind:value={text} onkeydown={keydown} rows="2" placeholder={running ? t("작업 중인 에이전트에게 끼워 넣기") : t("메시지 보내기")} aria-label={t("메시지")} disabled={!link?.online}></textarea>
				<button class="send" onclick={() => send(false)} disabled={!text.trim() || sending || !link?.online} aria-label={running ? t("끼워 넣기") : t("보내기")} title={running ? t("끼워 넣기") : t("보내기")}><Icon name={running ? "bolt" : "arrow-up"} /></button>
			</div>
			<p class="hint" class:bad={!!sendError}>{sendError || hint}</p>
		</div>
	</div>
</Modal>

<style>
	.quick {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
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
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px var(--dlg-px);
	}
	/* a scrolling column: its rows keep their height (a work box clips its corners, so it would shrink to nothing) */
	.list > :global(*) {
		flex: none;
	}
	.note {
		margin: 0;
		color: var(--text-faint);
		font-size: var(--fs-sm);
		line-height: 20px;
	}
	.note.bad {
		color: var(--danger);
	}
	.msg.user {
		align-self: flex-end;
		max-width: 85%;
	}
	.bubble {
		padding: 8px 12px;
		border-radius: var(--radius);
		background: var(--user-bg);
		font-size: var(--fs-md);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.msg.agent {
		min-width: 0;
	}
	.write {
		flex: none;
		padding: 12px var(--dlg-px) calc(12px + var(--sab));
		border-top: 1px solid var(--border);
	}
	.box {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 8px 8px 8px 16px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-panel);
		background: var(--bg-elev);
	}
	.box:focus-within {
		border-color: var(--text-faint);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
	textarea {
		flex: 1;
		min-width: 0;
		max-height: 200px;
		padding: 6px 0; /* 6 + 20 + 6 = the 32px send button beside it */
		border: 0;
		background: none;
		resize: none;
		font: inherit;
		font-size: var(--fs-md);
		line-height: 20px;
		color: var(--text);
		outline: none;
		field-sizing: content;
	}
	.send {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 16px;
	}
	.send:disabled {
		opacity: 0.4;
	}
	.hint {
		margin: 8px 0 0;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
	}
	.hint.bad {
		color: var(--danger);
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
