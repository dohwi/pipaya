<script lang="ts">
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import DialogBody from "../ui/DialogBody.svelte";
	import Modal from "../ui/Modal.svelte";
	import SessionsPanel from "./SessionsPanel.svelte";

	/** A server's deleted (closed) conversation list: restore or permanently delete conversations by folder. Opened from the server's header in the sidebar. */
	let { serverId }: { serverId: string } = $props();
	const server = $derived(app.servers.find((s) => s.id === serverId));
	const filter = $derived(app.sessionsFilter);
	const close = () => {
		app.sessionsDialog = null;
		app.sessionsFilter = null;
	};
	let count = $state<number | null>(null);
	let busy = $state(false);
	let reload = $state<(() => void) | undefined>();
	const title = t("삭제된 대화 목록");
	const sub = $derived([server ? app.serverLabel(server) : null, filter?.cwd].filter(Boolean).join(" · ") || null);
</script>

<Modal onclose={close} label={title} {title} {sub} width="l" maxHeight="720px" safeArea {titleExtra} {headerActions}>
	<DialogBody busy={busy}><SessionsPanel {serverId} cwd={filter?.cwd} bind:count bind:reload bind:busy /></DialogBody>
</Modal>

{#snippet titleExtra()}{#if count !== null}<span class="n">{count}</span>{/if}{/snippet}
{#snippet headerActions()}<IconButton icon="retry" label={t("새로고침")} tip onclick={() => reload?.()} disabled={busy} />{/snippet}

<style>
	.n {
		margin-left: 8px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
</style>
