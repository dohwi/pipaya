<script lang="ts">
	import IconButton from "./IconButton.svelte";
	import McpPanel from "./McpPanel.svelte";
	import Modal from "./Modal.svelte";
	import type { Api } from "../lib/api";
	import { t } from "../lib/i18n";
	import type { McpInfo } from "../lib/types";

	let { api, onclose }: { api: Api; onclose: () => void } = $props();
	let data = $state<McpInfo | null>(null);
	let loading = $state(true);
	let refresh = $state(0);
</script>

<Modal {onclose} title={t("MCP 서버")} sub={data ? t("연결된 서버 {n}개 · 도구 {tools}개", { n: data.ready, tools: data.tools }) : null} width="xl" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} disabled={loading} />
	{/snippet}
	<div class="wrap"><McpPanel {api} bind:data bind:loading {refresh} /></div>
</Modal>

<style>
	.wrap { overflow-y: auto; padding: var(--dlg-body-t) var(--dlg-px) var(--dlg-body-b); min-height: 80px; border-top: 1px solid var(--border); }
</style>
