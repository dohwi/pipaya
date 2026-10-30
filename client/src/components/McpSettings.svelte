<script lang="ts">
	import { t } from "../lib/i18n";
	import { Api } from "../lib/api";
	import { app } from "../lib/store.svelte";
	import McpPanel from "./McpPanel.svelte";

	/** MCP servers of one server, read from and saved to that server only (not the open one, unless it is). */
	let { serverId }: { serverId: string } = $props();
	const api = $derived.by(() => {
		const s = app.servers.find((x) => x.id === serverId);
		return s ? new Api({ baseUrl: s.baseUrl, token: s.token }) : null;
	});
</script>

<section>
	<div class="section-label">{t("MCP 서버")}</div>
	{#if api}{#key serverId}<McpPanel {api} />{/key}{/if}
</section>

<style>
	section { display: flex; flex-direction: column; gap: 8px; }
</style>
