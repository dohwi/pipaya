<script lang="ts">
	import Notice from "../ui/Notice.svelte";
	import Button from "../ui/Button.svelte";
	import { t } from "../../lib/i18n";
	import { updater } from "../../lib/updater.svelte";
	import { serverUpdater } from "../../lib/server-update.svelte";
	import { app } from "../../lib/store.svelte";
	import { serverReleaseState, serverVersionLabel } from "../../lib/protocol";
	import { collapseIn, collapseOut } from "../../lib/motion";
	import Badge from "../ui/Badge.svelte";
	import ConfirmButton from "../ui/ConfirmButton.svelte";

	/** Only the server the app is connected to can be asked: it is the one `updater.connection` talks to. */
	const busy = $derived(serverUpdater.busy);
	const checking = $derived(serverUpdater.phase === "checking");
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
	/** Running conversations block the update (the restart would cut them off); this goes ahead anyway, after a second press. */
	const forceUpdate = () => app.updateServerSoftware(updater.connection?.().api ?? null, true);
</script>

{#if status || version}
	<div class="section-label head">{t("서버 버전")}</div>
	<div class="item">
		<div class="meta">
			{#if shown.from}
				<span class="ver">{shown.from}{#if isNew && shown.to} → {shown.to}{/if}</span>
			{/if}
			{#if serverUpdater.progressLabel}
				<Badge tone="warn">{serverUpdater.progressLabel}</Badge>
			{:else if isNew}
				<Badge tone="ok">{t("서버에 새 버전이 있습니다")}</Badge>
			{:else if release === "older"}
				<Badge tone="warn">{t("앱보다 오래된 버전입니다")}</Badge>
			{:else if status || release === "current"}
				<Badge>{t("최신 버전입니다")}</Badge>
			{/if}
		</div>
		<div class="actions">
			{#if isNew}
				{#if serverUpdater.blockedByRuns && !busy}
					<ConfirmButton size="sm" confirmLabel={t("정말 중지")} onconfirm={forceUpdate}>{t("중지하고 업데이트")}</ConfirmButton>
				{/if}
				<Button size="sm" variant="update" disabled={busy} onclick={update}>{t("서버 업데이트")}</Button>
			{:else}
				<Button size="sm" disabled={busy} onclick={check}>
					<svg class:spin={checking} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
					{checking ? t("확인하는 중…") : t("업데이트 확인")}
				</Button>
			{/if}
		</div>
	</div>
	{#if release === "older" && !isNew && !busy}
		<p class="hint note" in:collapseIn out:collapseOut>{t("서버가 앱보다 오래된 버전입니다. 서버에서 업데이트를 실행하세요 (install.sh update)")}</p>
	{/if}
	{#if serverUpdater.error}<div class="err-gap" in:collapseIn out:collapseOut><Notice tone="danger" size="sm">{serverUpdater.error}</Notice></div>{/if}
{/if}

<style>
	.head { margin-bottom: 12px; }
	/* version and status stack on the left, the single update/check action sits on the right; when narrow it wraps cleanly */
	.item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 12px; min-height: 56px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
	/* 160px: the narrowest the version + status column may get before the buttons move to their own line */
	.meta { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex: 1 1 160px; min-width: 0; }
	.ver { max-width: 100%; font-size: var(--fs-sm); line-height: 20px; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-left: auto; }
	.actions :global(.btn) { flex: none; white-space: nowrap; }
	.actions :global(.btn svg) { width: 14px; height: 14px; }
	.note { line-height: 1.6; margin: 8px 0 0; }
	.err-gap { padding-top: 8px; }
</style>
