<script lang="ts">
	import { t } from "../lib/i18n";
	import { sheetPull } from "../lib/sheet";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import ModelConnections from "./ModelConnections.svelte";
	import { app } from "../lib/store.svelte";

	const close = () => (app.connectionsOpen = false);
</script>

<Modal onclose={close} label={t("모델 연결")} width="l" maxHeight="680px" safeArea>
	<header use:sheetPull={{ onclose: close }}>
		<div class="title">
			<h2>{t("모델 연결")}</h2>
			{#if app.server}<span class="sub">{app.serverLabel(app.server)}</span>{/if}
		</div>
		<button class="iconbtn" onclick={close} aria-label={t("닫기")}><Icon name="x" /></button>
	</header>
	<div class="body">
		{#if app.serverId}<ModelConnections serverId={app.serverId} />{/if}
	</div>
</Modal>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 14px 10px 22px;
		border-bottom: 1px solid var(--border);
	}
	.title {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: var(--fs-xl);
	}
	.sub {
		font-size: var(--fs-xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.body {
		padding: 18px 22px 22px;
		overflow-y: auto;
	}
</style>
