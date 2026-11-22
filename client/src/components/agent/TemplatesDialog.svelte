<script lang="ts">
	import DialogBody from "../ui/DialogBody.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Modal from "../ui/Modal.svelte";
	import TemplatesPanel from "./TemplatesPanel.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import type { Api } from "../../lib/api";

	/** Built-in `/prompt:<name>` templates for one conversation's working directory and the global folder. */
	let { dialog: target, onclose }: { dialog: { cwd: string }; api: Api; onclose: () => void } = $props();
	let refresh = $state(0);
	let count = $state<{ total: number } | null>(null);
	const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
</script>

<Modal {onclose} title={t("프롬프트 템플릿")} sub={count ? `${t("{n}개", { n: count.total })} · ${home(target.cwd)}` : home(target.cwd)} width="xl" maxHeight="760px" safeArea>
	{#snippet headerActions()}
		<IconButton icon="retry" label={t("새로고침")} tip onclick={() => refresh++} />
	{/snippet}
	<DialogBody gap>
		{#if app.serverId}<TemplatesPanel serverId={app.serverId} cwd={target.cwd} bare {refresh} bind:count />{/if}
	</DialogBody>
</Modal>
