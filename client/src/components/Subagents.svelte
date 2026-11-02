<script lang="ts">
	import DialogBody from "./DialogBody.svelte";
	import Modal from "./Modal.svelte";
	import SubagentSettings from "./SubagentSettings.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import type { Api } from "../lib/api";

	/**
	 * The helper roles one conversation can delegate to, opened from the footer: the global ones and the ones in that
	 * conversation's own folder, with add / edit / remove (the same list as in the settings).
	 */
	let { dialog: target, onclose }: { dialog: { cwd: string }; api: Api; onclose: () => void } = $props();
	const models = $derived(app.models.filter((m) => !m.imageGeneration));
</script>

<Modal {onclose} title={t("도우미 역할")} sub={target.cwd.replace(/^\/home\/[^/]+/, "~")} width="xl" maxHeight="760px" safeArea>
	<DialogBody gap>
		{#if app.serverId}<SubagentSettings serverId={app.serverId} {models} cwd={target.cwd} bare />{/if}
	</DialogBody>
</Modal>
