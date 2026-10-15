<script lang="ts">
	import { t } from "../lib/i18n";
	import Modal from "./Modal.svelte";
	import ModelConnections from "./ModelConnections.svelte";
	import { app } from "../lib/store.svelte";

	const close = () => (app.connectionsOpen = false);
</script>

<Modal onclose={close} title={t("모델 연결")} sub={app.server ? app.serverLabel(app.server) : null} divider width="l" maxHeight="680px" safeArea>
	<div class="body">
		{#if app.serverId}<ModelConnections serverId={app.serverId} />{/if}
	</div>
</Modal>

<style>
	.body {
		padding: 18px 22px 22px;
		overflow-y: auto;
	}
</style>
