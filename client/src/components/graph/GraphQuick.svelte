<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { errorText, type StoredMessage } from "../../lib/api";
	import { textOf } from "../../lib/chat.svelte";
	import { sessionTitle } from "../../lib/session-title";
	import { activityOf } from "../../lib/activity";
	import { queuedShown } from "../../lib/queue";
	import { toolSummary } from "../../lib/tools";
	import Modal from "../ui/Modal.svelte";
	import Icon from "../ui/Icon.svelte";
	import Markdown from "../chat/Markdown.svelte";
	import AgentBadge from "../shell/AgentBadge.svelte";

	/**
	 * A chat looked at from the graph view without leaving it: its newest messages and an input. While the agent works,
	 * Enter steers (goes into the running turn) and Alt+Enter queues for after it; when idle, Enter starts a turn. The
	 * quick view follows the chat while open. "대화 열기" goes to the chat itself.
	 */
	let { server, session, onclose }: { server: string; session: string; onclose: () => void } = $props();

	const link = $derived(app.links[server]);
	const s = $derived(link?.sessionById.get(session));
	const activity = $derived(link ? activityOf(link.data, session) : "idle");
	const running = $derived(!!link?.data.running[session]);
	const queued = $derived(link?.data.queued[session] ?? []);
	const tool = $derived(link?.data.tool[session]);

	/** The newest turns: what the user said, and the agent's text replies (tool calls are summed up in one line). */
	const TAIL = 40;
	type Line = { key: string; who: "user" | "agent" | "tool"; text: string };
	let lines = $state<Line[]>([]);
	let loading = $state(true);
	let error = $state("");
	let lastSeq = -1;

	function linesOf(ms: StoredMessage[]): Line[] {
		const out: Line[] = [];
		for (const m of ms) {
			const msg = m.message as { role: string; content?: unknown };
			if (msg.role === "user") {
				const text = queuedShown(textOf(msg.content)).trim();
				if (text) out.push({ key: `u${m.seq}`, who: "user", text });
			} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
				const text = textOf(msg.content).trim();
				if (text) out.push({ key: `a${m.seq}`, who: "agent", text });
				const calls = (msg.content as { type?: string; name?: string; arguments?: Record<string, unknown> }[]).filter((c) => c?.type === "toolCall");
				if (calls.length) out.push({ key: `t${m.seq}`, who: "tool", text: calls.map((c) => `${c.name} ${toolSummary(String(c.name), c.arguments ?? {})}`.trim()).join("\n") });
			}
		}
		return out;
	}

	async function load() {
		const api = link?.api;
		if (!api) return;
		try {
			const ms = await api.tailMessages(session, TAIL);
			lines = linesOf(ms);
			lastSeq = ms.at(-1)?.seq ?? lastSeq;
			error = "";
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	/** Only what came after the newest message shown. */
	async function more() {
		const api = link?.api;
		if (!api || lastSeq < 0) return load();
		try {
			const ms = await api.messages(session, lastSeq);
			if (!ms.length) return;
			lines = [...lines, ...linesOf(ms)].slice(-TAIL);
			lastSeq = ms.at(-1)!.seq;
		} catch {
			/* the next tick tries again */
		}
	}
	$effect(() => {
		void load();
		const id = setInterval(() => void more(), 2000);
		return () => clearInterval(id);
	});

	let list: HTMLDivElement | undefined = $state();
	let stuck = true;
	$effect(() => {
		void lines.length;
		if (list && stuck) requestAnimationFrame(() => list && (list.scrollTop = list.scrollHeight));
	});

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
			void more();
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
	const sub = $derived([link ? (app.servers.find((x) => x.id === server)?.name ?? server) : "", s?.name ? `@${s.name}` : "", s?.cwd.split("/").slice(-2).join("/") ?? ""].filter(Boolean).join(" · "));

	function openChat() {
		onclose();
		app.openIn(server, { session });
	}
</script>

<Modal {onclose} label={sessionTitle(s?.title)} title={sessionTitle(s?.title)} {sub} subMono width="720px" maxHeight="640px" height="640px" divider>
	{#snippet headerActions()}
		<button class="open" onclick={openChat} title={t("대화 열기")}><Icon name="arrow-right" />{t("대화 열기")}</button>
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
			{:else if !lines.length}
				<p class="note">{t("아직 메시지가 없습니다")}</p>
			{/if}
			{#each lines as l (l.key)}
				{#if l.who === "tool"}
					<div class="tool mono">{l.text}</div>
				{:else}
					<div class="msg {l.who}">
						{#if l.who === "user"}<div class="bubble">{l.text}</div>{:else}<Markdown text={l.text} sessionId={null} />{/if}
					</div>
				{/if}
			{/each}
		</div>
		<div class="write">
			<div class="box">
				<!-- svelte-ignore a11y_autofocus -->
				<textarea bind:value={text} onkeydown={keydown} rows="2" autofocus placeholder={running ? t("작업 중인 에이전트에게 끼워 넣기") : t("메시지 보내기")} aria-label={t("메시지")} disabled={!link?.online}></textarea>
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
		display: inline-flex;
		align-items: center;
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
		line-height: 20px;
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
		max-width: 80%;
	}
	.bubble {
		padding: 8px 12px;
		border-radius: var(--radius);
		background: var(--user-bg);
		font-size: var(--fs-sm);
		line-height: 20px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.msg.agent {
		font-size: var(--fs-sm);
	}
	.tool {
		padding: 4px 8px;
		border-left: 2px solid var(--border-strong);
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
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
		max-height: 160px;
		padding: 6px 0; /* 6 + 20 + 6 = the 32px send button beside it */
		border: 0;
		background: none;
		resize: none;
		font: inherit;
		font-size: var(--fs-sm);
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
</style>
