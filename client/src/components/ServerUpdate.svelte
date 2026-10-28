<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { updater } from "../lib/updater.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { app } from "../lib/store.svelte";
	import { serverReleaseState, serverVersionLabel } from "../lib/protocol";
	import { collapseIn, collapseOut } from "../lib/motion";
	import UpdateHeader from "./UpdateHeader.svelte";
	import StatusChip from "./StatusChip.svelte";

	/** Only the server the app is connected to can be asked: it is the one `updater.connection` talks to. */
	const busy = $derived(serverUpdater.busy);
	const status = $derived(serverUpdater.status?.managed ? serverUpdater.status : null);
	const version = $derived(app.serverVersions?.version ?? "");
	/** Without a git status (not self-updating, or the fetch failed) compare the release with the app's: they ship together. */
	const release = $derived(serverReleaseState(version, updater.current));
	const isNew = $derived(Boolean(status?.available));
	const shown = $derived(serverVersionLabel(serverUpdater.status, version));

	async function check() {
		const conn = updater.connection?.();
		if (conn?.api && conn.serverId) await serverUpdater.check(conn.api, conn.serverId, true);
	}

	const update = () => app.updateServerSoftware(updater.connection?.().api ?? null);
</script>

{#if status || version}
	<UpdateHeader label={t("서버 버전")} checking={serverUpdater.phase === "checking"} disabled={busy} onclick={check} />
	<div class="item">
		<div class="meta">
			{#if shown.from}
				<span class="ver">{shown.from}{#if isNew && shown.to} → {shown.to}{/if}</span>
			{/if}
		</div>
		{#if serverUpdater.progressLabel}
			<StatusChip tone="warn">{serverUpdater.progressLabel}</StatusChip>
		{:else if isNew}
			<StatusChip tone="ok">{t("서버에 새 버전이 있습니다")}</StatusChip>
		{:else if release === "older"}
			<StatusChip tone="warn">{t("앱보다 오래된 버전입니다")}</StatusChip>
		{:else if status || release === "current"}
			<StatusChip tone="neutral">{t("최신 버전입니다")}</StatusChip>
		{/if}
		{#if isNew}
			<Button size="sm" variant="update" disabled={busy} onclick={update}>{t("서버 업데이트")}</Button>
		{/if}
	</div>
	{#if release === "older" && !isNew && !busy}
		<p class="hint note" in:collapseIn out:collapseOut>{t("서버가 앱보다 오래된 버전입니다. 서버에서 업데이트를 실행하세요 (install.sh update)")}</p>
	{/if}
	{#if serverUpdater.error}<p class="hint danger note" role="alert" in:collapseIn out:collapseOut>{serverUpdater.error}</p>{/if}
{/if}

<style>
	.item { display: flex; align-items: center; gap: 8px; padding: 12px 12px; min-height: 56px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); }
	.meta { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: 0; }
	.ver { font-size: var(--fs-sm); color: var(--text); font-variant-numeric: tabular-nums; }
	.item :global(.btn) { flex: none; white-space: nowrap; }
	.note { line-height: 1.6; margin: 8px 0 0; }
</style>
