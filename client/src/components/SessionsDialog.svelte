<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Modal from "./Modal.svelte";
	import SessionsPanel from "./SessionsPanel.svelte";

	/** A server's conversation list: archive, restore and delete conversations by folder. Opened from the server's header in the sidebar. */
	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const close = () => (app.sessionsDialog = null);
</script>

<Modal onclose={close} label={t("대화 목록")} title={t("대화 목록")} sub={server ? app.serverLabel(server) : null} width="l" maxHeight="720px">
	<div class="body"><SessionsPanel {serverId} /></div>
</Modal>

<style>
	.body {
		padding: 4px 20px 20px;
		overflow-y: auto;
		min-height: 0;
	}
</style>
