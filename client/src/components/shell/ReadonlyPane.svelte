<script lang="ts">
	import { ChatState } from "../../lib/chat.svelte";
	import { t } from "../../lib/i18n";
	import { setPane } from "../../lib/pane";
	import { app } from "../../lib/store.svelte";
	import MessageList from "../chat/MessageList.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";

	/**
	 * Read-only transcript view used inside `SessionQuickModal` for closed sessions or sessions on another server,
	 * without switching `app.serverId` or mutating `app.chats`.
	 */
	let {
		server,
		session,
		closed = false,
		onopen,
	}: { server: string; session: string; closed?: boolean; onopen: () => void } = $props();

	let chat = $state<ChatState | null>(null);
	setPane(() => ({ id: session, focused: true, readonly: true, server, chat }));

	const link = $derived(app.links[server]);
	const serverName = $derived.by(() => {
		const srv = app.servers.find((x) => x.id === server);
		return srv ? app.serverLabel(srv) : server;
	});

	$effect(() => {
		const api = link?.api;
		const sid = session;
		if (!api) {
			chat = null;
			return;
		}
		const state = new ChatState(sid, api);
		chat = state;
		void state.load();
		return () => {
			state.dispose();
			if (chat === state) chat = null;
		};
	});
</script>

<section class="pane readonly" data-part="pane" data-pane={session}>
	<div class="body">
		{#if chat}
			<div class="list">
				<MessageList {chat} />
			</div>
		{:else}
			<p class="note">{t("불러오는 중…")}</p>
		{/if}
	</div>
	<div class="robar">
		<span class="roinfo">
			<Icon name={closed ? "clock" : "server"} />
			<span>
				{#if closed}
					{t("닫힌 대화입니다 · 읽기 전용으로 보고 있습니다")}
				{:else}
					{t("{server} 서버의 대화 · 읽기 전용으로 보고 있습니다", { server: serverName })}
				{/if}
			</span>
		</span>
		<Button size="sm" variant="primary" onclick={onopen}>
			{closed ? t("다시 열기") : t("대화 열기")}
		</Button>
	</div>
</section>

<style>
	.pane {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
		background: var(--bg);
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	.list {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.note {
		margin: auto;
		color: var(--text-faint);
		font-size: var(--fs-sm);
	}
	.robar {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
	}
	.roinfo {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text-dim);
	}
	.roinfo :global(.ic) {
		flex: none;
		font-size: 16px;
		color: var(--text-faint);
	}
</style>
