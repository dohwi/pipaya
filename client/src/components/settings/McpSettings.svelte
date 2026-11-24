<script lang="ts">
	import { Api } from "../../lib/api";
	import { app } from "../../lib/store.svelte";
	import McpPanel from "../agent/McpPanel.svelte";

	/** MCP servers of one server, read from and saved to that server only (not the open one, unless it is). */
	let { serverId, only = null, onselect }: { serverId: string; only?: string | null; onselect?: (name: string | null) => void } = $props();
	const api = $derived.by(() => {
		const s = app.servers.find((x) => x.id === serverId);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	});
</script>

<!-- the list dialog's own shape (intro, group, cards, dashed add, inline form) straight on the page, like 예약 작업:
     a grey settings card around it put the form 16px inside the page's left and right lines -->
{#if api}{#key serverId}<McpPanel {api} {only} {onselect} />{/key}{/if}
