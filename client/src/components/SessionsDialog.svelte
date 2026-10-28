<script lang="ts">
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import Modal from "./Modal.svelte";
	import SessionsPanel from "./SessionsPanel.svelte";

	/** A server's conversation list: archive, restore and delete conversations by folder. Opened from the server's header in the sidebar. */
	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const filter = $derived(app.sessionsFilter);
	const close = () => {
		app.sessionsDialog = null;
		app.sessionsFilter = null;
	};
	const title = $derived(filter?.archived ? t("보관함") : t("대화 목록"));
	const sub = $derived([server ? app.serverLabel(server) : null, filter?.cwd].filter(Boolean).join(" · ") || null);
</script>

<Modal onclose={close} label={title} {title} {sub} width="l" maxHeight="720px">
	<div class="body"><SessionsPanel {serverId} cwd={filter?.cwd} archivedOnly={!!filter?.archived} /></div>
</Modal>

<style>
	.body {
		padding: 4px var(--dlg-px) var(--dlg-body-b);
		overflow-y: auto;
		min-height: 0;
	}
</style>
