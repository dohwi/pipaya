<script lang="ts">
	import DialogBody from "../ui/DialogBody.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Modal from "../ui/Modal.svelte";
	import SubagentsPanel from "./SubagentsPanel.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import type { Api } from "../../lib/api";

	/**
	 * The helper roles one conversation can delegate to, opened from the footer: the global ones and the ones in that
	 * conversation's own folder, with add / edit / remove (the same list as in the settings).
	 */
	let { dialog: target, onclose }: { dialog: { cwd: string }; api: Api; onclose: () => void } = $props();
	let refresh = $state(0);
	let count = $state<{ on: number; total: number } | null>(null);
	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
	const models = $derived(app.models.filter((m) => !m.imageGeneration));
</script>

<Modal {onclose} title={t("도우미 역할")} sub={count ? `${t("{total}개 중 {on}개 사용", count)} · ${home(target.cwd)}` : home(target.cwd)} width="xl" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} />
	{/snippet}
	<DialogBody gap>
		{#if app.serverId}<SubagentsPanel serverId={app.serverId} {models} cwd={target.cwd} {refresh} bind:count bare />{/if}
	</DialogBody>
</Modal>
