<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { errorText, type StoredMessage } from "../../lib/api";
	import { sessionTitle } from "../../lib/session-title";
	import { activityOf } from "../../lib/activity";
	import { toolSummary } from "../../lib/tools";
	import { quickItems, type QuickItem } from "../../lib/graph-quick";
	import { viewport } from "../../lib/viewport.svelte";
	import Icon from "../ui/Icon.svelte";
	import QuickWork from "./QuickWork.svelte";
	import Markdown from "../chat/Markdown.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";

	/**
	 * A chat looked at from the graph view without leaving it, in a panel docked to the right of the canvas (the whole
	 * graph area on a phone): its newest messages, the tool calls as work boxes, and an input. While the agent works,
	 * Enter steers (goes into the running turn) and Alt+Enter queues for after it; when idle, Enter starts a turn.
	 * Clicking another chat on the canvas switches the panel to it. "대화 열기" goes to the chat itself.
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

	// ---- width: the panel's left edge is dragged; the width is kept on this device ----
	const W_KEY = "pipaya.graph.quickWidth";
	const W_MIN = 360;
	let width = $state(Number(localStorage.getItem(W_KEY)) || 0);
	/** By default about half of the graph area: room to read, and the canvas keeps its toolbar and most columns. */
	let host: HTMLElement | undefined = $state();
	const maxW = () => Math.max(W_MIN, (host?.parentElement?.clientWidth ?? 1200) - 320);
	const shownW = $derived(width ? Math.min(width, maxW()) : Math.max(W_MIN, Math.round((host?.parentElement?.clientWidth ?? 1200) * 0.48)));
	let resizing = $state(false);
	function grip(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		const x0 = e.clientX, w0 = shownW;
		resizing = true;
		const move = (ev: PointerEvent) => (width = Math.round(Math.min(maxW(), Math.max(W_MIN, w0 + x0 - ev.clientX))));
		const up = () => {
			resizing = false;
			removeEventListener("pointermove", move);
			removeEventListener("pointerup", up);
			try {
				localStorage.setItem(W_KEY, String(width));
			} catch {
				/* private mode: this visit only */
			}
		};
		addEventListener("pointermove", move);
		addEventListener("pointerup", up);
	}
	function gripKey(e: KeyboardEvent) {
		const step = e.shiftKey ? 64 : 16;
		if (e.key === "ArrowLeft") width = Math.min(maxW(), shownW + step);
		else if (e.key === "ArrowRight") width = Math.max(W_MIN, shownW - step);
		else return;
		e.preventDefault();
		localStorage.setItem(W_KEY, String(width));
	}
	function resetWidth() {
		width = 0;
		localStorage.removeItem(W_KEY);
	}
	function panelKey(e: KeyboardEvent) {
		if (e.key === "Escape" && !e.isComposing) {
			e.stopPropagation();
			onclose();
		}
	}

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

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="quick" class:resizing bind:this={host} style:width={viewport.narrow ? undefined : `${shownW}px`} aria-label={sessionTitle(s?.title)} onkeydown={panelKey}>
	{#if !viewport.narrow}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="grip" role="separator" aria-orientation="vertical" tabindex="0" aria-label={t("패널 너비 조절")} aria-valuenow={shownW} aria-valuemin={W_MIN} title={t("끌어서 너비 조절 · 더블 클릭으로 원래 크기")} onpointerdown={grip} ondblclick={resetWidth} onkeydown={gripKey}></div>
	{/if}
	<header class="head">
		<AgentBadge id={session} {server} state={activity} size={20} />
		<div class="ttl">
			<span class="t">{sessionTitle(s?.title)}</span>
			<span class="sub mono">{sub}</span>
		</div>
		<button class="open" onclick={openChat} title={t("대화 열기")}><Icon name="arrow-right" /><span class="lbl">{t("대화 열기")}</span></button>
		<button class="x" onclick={onclose} aria-label={t("닫기")} title={t("닫기") + " (Esc)"}><Icon name="x" /></button>
	</header>
	<div class="state">
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
</aside>

<style>
	.quick {
		position: relative;
		flex: none;
		min-width: 0;
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--border);
		background: var(--bg);
	}
	.quick.resizing {
		user-select: none;
	}
	/* on a phone the panel is the whole graph area; the canvas waits behind it */
	@media (max-width: 860px) {
		.quick {
			position: absolute;
			inset: 0;
			z-index: 3;
			border-left: 0;
		}
	}
	.grip {
		position: absolute;
		left: -4px;
		top: 0;
		bottom: 0;
		width: 8px;
		z-index: 1;
		cursor: col-resize;
		touch-action: none;
	}
	.grip::after {
		content: "";
		position: absolute;
		left: 3px;
		top: 0;
		bottom: 0;
		width: 2px;
		background: transparent;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.grip:focus-visible::after,
	.quick.resizing .grip::after {
		background: var(--accent);
	}
	@media (hover: hover) {
		.grip:hover::after {
			background: var(--border-strong);
		}
	}
	.head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 8px 8px 16px;
		border-bottom: 1px solid var(--border);
	}
	.ttl {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.ttl .t {
		font-size: var(--fs-md);
		font-weight: 600;
		line-height: 20px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ttl .sub {
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.open,
	.x {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 32px;
		border-radius: var(--radius-sm);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		font-weight: 600;
		line-height: 16px;
	}
	.open {
		padding: 0 12px;
	}
	.x {
		width: 32px;
	}
	.open :global(.ic),
	.x :global(.ic) {
		font-size: 16px;
	}
	@media (hover: hover) {
		.open:hover,
		.x:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.state {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
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
		padding: 16px;
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
		padding: 12px 16px calc(12px + var(--sab));
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
