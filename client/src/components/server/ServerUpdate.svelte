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
	const updating = $derived(serverUpdater.phase === "updating" || serverUpdater.phase === "restarting");
	const pending = $derived(serverUpdater.pending);
	const status = $derived(serverUpdater.status?.managed ? serverUpdater.status : null);
	const version = $derived(app.serverVersions?.version ?? "");
	/** Without a git status (not self-updating, or the fetch failed) compare the release with the app's: they ship together. */
	const release = $derived(serverReleaseState(version, updater.current));
	const isNew = $derived(Boolean(status?.available));
	const shown = $derived(serverVersionLabel(serverUpdater.status, version));
	const multi = $derived(isNew && (pending || (serverUpdater.blockedByRuns && !busy)));

	async function check() {
		const conn = updater.connection?.();
		if (conn?.api && conn.serverId) await serverUpdater.check(conn.api, conn.serverId, true);
	}

	const update = () => app.updateServerSoftware(updater.connection?.().api ?? null);
	/** Running conversations block an immediate restart; this stops them and restarts right away after a second press. */
	const forceUpdate = () => app.updateServerSoftware(updater.connection?.().api ?? null, true);
	const cancel = () => app.cancelServerUpdate(updater.connection?.().api ?? null);
</script>

{#if status || version}
	<div class="section-label head">{t("서버 버전")}</div>
	<div class="item" class:multi>
		<div class="meta">
			{#if shown.from}
				<span class="ver">{shown.from}{#if isNew && shown.to} → {shown.to}{/if}</span>
			{/if}
			{#if serverUpdater.progressLabel}
				<Badge tone="warn">{serverUpdater.progressLabel}</Badge>
			{:else if !isNew && release === "older"}
				<Badge tone="warn">{t("앱보다 오래된 버전입니다")}</Badge>
			{:else if !isNew && (status || release === "current")}
				<Badge>{t("최신 버전입니다")}</Badge>
			{/if}
		</div>
		<div class="actions">
			{#if isNew}
				{#if pending}
					<Button size="sm" onclick={cancel}>{t("대기 취소")}</Button>
					<ConfirmButton size="sm" confirmLabel={t("정말 중지")} onconfirm={forceUpdate}>{t("중지하고 업데이트")}</ConfirmButton>
				{:else}
					{#if serverUpdater.blockedByRuns && !busy}
						<ConfirmButton size="sm" confirmLabel={t("정말 중지")} onconfirm={forceUpdate}>{t("중지하고 업데이트")}</ConfirmButton>
					{/if}
					<Button size="sm" variant="update" busy={updating} disabled={busy} onclick={update}>{t("서버 업데이트")}</Button>
				{/if}
			{:else}
				<Button size="sm" disabled={busy} onclick={check}>
					<svg class:spin={checking} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
					{checking ? t("확인하는 중…") : t("업데이트 확인")}
				</Button>
			{/if}
		</div>
	</div>
	{#if pending}
		<p class="hint note" in:collapseIn out:collapseOut>{t("실행 중인 대화가 끝나면 자동으로 업데이트하고 서버를 다시 시작합니다.")}</p>
	{:else if release === "older" && !isNew && !busy}
		<p class="hint note" in:collapseIn out:collapseOut>{t("서버가 앱보다 오래된 버전입니다. 서버에서 업데이트를 실행하세요 (install.sh update)")}</p>
	{/if}
	{#if serverUpdater.error}<div class="err-gap" in:collapseIn out:collapseOut><Notice tone="danger" size="sm" raised>{serverUpdater.error}</Notice></div>{/if}
{/if}

<style>
	.head { margin-bottom: 12px; }
	/* borderless page-tinted surface inside .set-group (no box-in-box, matching ListItem) */
	.item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 12px;
		min-height: 56px;
		background: var(--item-bg, var(--bg));
		border-radius: var(--radius-sm);
	}
	/* 120px: fits "0.10.5 → 0.10.6" beside the single update button on one line on phones */
	.meta { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex: 1 1 120px; min-width: 0; }
	.ver { max-width: 100%; font-size: var(--fs-sm); line-height: 20px; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-left: auto; }
	.actions :global(.btn) { flex: none; white-space: nowrap; }
	.actions :global(.btn svg) { width: 14px; height: 14px; }
	/* phones: when two actions stack under the meta block, stretch them edge-to-edge under a hairline instead of floating right */
	@media (max-width: 640px) {
		.item.multi {
			flex-direction: column;
			align-items: stretch;
			gap: 12px;
		}
		.item.multi .meta {
			flex: none;
		}
		.item.multi .actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			width: 100%;
			margin-left: 0;
			padding-top: 12px;
			border-top: 1px solid var(--border);
		}
		.item.multi .actions :global(.btn) {
			width: 100%;
		}
	}
	.note { line-height: 20px; margin: 8px 0 0; }
	.err-gap { padding-top: 8px; }
</style>
