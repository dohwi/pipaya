<script lang="ts">
	import IconButton from "./IconButton.svelte";
	import DialogBody from "./DialogBody.svelte";
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
	<DialogBody busy={loading}><McpPanel {api} bind:data bind:loading {refresh} /></DialogBody>
</Modal>
