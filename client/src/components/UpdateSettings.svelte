<script lang="ts">
	import { t } from "../lib/i18n";
	import { updater } from "../lib/updater.svelte";
	import { notificationPlatform } from "../lib/notifications";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { app } from "../lib/store.svelte";
	import Switch from "./Switch.svelte";

	const android = notificationPlatform() === "android";
	const checking = $derived(updater.phase === "checking");
	const downloading = $derived(updater.phase === "downloading" || updater.phase === "ready");
	const serverBusy = $derived(serverUpdater.busy);
	const serverStatus = $derived(serverUpdater.status?.managed ? serverUpdater.status : null);

	/** Checks the app and, when connected as the owner, the server it talks to. */
	async function checkAll() {
		const conn = updater.connection?.();
		await Promise.all([
			updater.check(true),
			conn?.api && conn.serverId ? serverUpdater.check(conn.api, conn.serverId, true) : Promise.resolve(),
		]);
	}

	async function updateServer() {
		const api = updater.connection?.().api;
		if (!api) return;
		if (await serverUpdater.apply(api)) {
			app.toast(t("서버를 업데이트했습니다"), "ok");
			await app.sync();
		}
	}
</script>

{#if updater.supported}
	{@const appNew = updater.phase === "available" || downloading}
	{@const serverNew = Boolean(serverStatus?.available)}
	<div class="head">
		<div class="label">{t("앱 업데이트")}</div>
		<button class="btn sm" disabled={checking || downloading || serverBusy} onclick={checkAll}>
			<svg class:spin={checking || serverUpdater.phase === "checking"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
			{checking || serverUpdater.phase === "checking" ? t("확인하는 중…") : t("업데이트 확인")}
		</button>
	</div>
	<div class="row">
		<span>{t("시작할 때 새 버전 확인")}</span>
		<Switch checked={updater.auto} label={t("시작할 때 새 버전 확인")} onchange={(on) => updater.setAuto(on)} />
	</div>
	<div class="card">
		<div class="item">
			<div class="meta">
				<span class="name">{t("앱")}</span>
				{#if updater.current}<span class="ver">{updater.current}</span>{/if}
			</div>
			{#if appNew}
				<span class="chip new">{t("새 버전 {version}을 사용할 수 있습니다", { version: updater.version })}</span>
			{:else if updater.phase === "idle" && updater.current}
				<span class="chip ok"><i></i>{t("최신 버전입니다")}</span>
			{/if}
			{#if updater.phase === "available"}
				<button class="btn primary sm" onclick={() => updater.install()}>{t("업데이트")}</button>
			{/if}
		</div>
		{#if downloading}
			<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(updater.progress * 100)}>
				<span style:width="{Math.round(updater.progress * 100)}%"></span>
			</div>
		{/if}
		{#if serverStatus}
			<div class="item">
				<div class="meta">
					<span class="name">{t("서버 버전")}</span>
				</div>
				{#if serverUpdater.phase === "updating"}
					<span class="chip new">{t("서버를 업데이트하는 중…")}</span>
				{:else if serverUpdater.phase === "restarting"}
					<span class="chip new">{t("서버가 다시 시작되기를 기다리는 중…")}</span>
				{:else if serverNew}
					<span class="chip new">{t("서버에 새 버전이 있습니다")}</span>
				{:else}
					<span class="chip ok"><i></i>{t("최신 버전입니다")}</span>
				{/if}
				{#if serverNew}
					<button class="btn primary sm" disabled={serverBusy} onclick={updateServer}>{t("서버 업데이트")}</button>
				{/if}
			</div>
		{/if}
	</div>
	{#if updater.error}<p class="error" role="alert">{updater.error}</p>{/if}
	{#if serverUpdater.error}<p class="error" role="alert">{serverUpdater.error}</p>{/if}
	<p class="hint">
		{android ? t("앱 안에서 내려받은 뒤 시스템 설치 화면이 열립니다. 설치를 한 번 확인해 주세요.") : t("업데이트는 서명을 확인한 뒤 설치하고 앱을 다시 시작합니다.")}
	</p>
{/if}

<style>
	.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
	.label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); }
	.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: var(--fs-sm); }
	.head .btn { flex: none; white-space: nowrap; }
	.head .btn svg { width: 14px; height: 14px; }
	.spin { animation: spin 0.9s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
	.card { margin-top: 12px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.item { display: flex; align-items: center; gap: 10px; padding: 12px 14px; min-height: 56px; }
	.item + .item, .bar + .item { border-top: 1px solid var(--border); }
	.meta { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
	.name { font-size: var(--fs-sm); font-weight: 500; }
	.ver { font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
	.chip { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-pill); font-size: var(--fs-xs); line-height: 1.5; text-align: right; }
	.chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
	.chip.ok { background: var(--ok-soft); color: var(--ok); }
	.chip.new { background: var(--accent-soft); color: var(--text); }
	.item .btn { flex: none; white-space: nowrap; }
	.bar { height: 3px; background: var(--border); }
	.bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-fast) var(--ease-std); }
	.hint { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.6; margin: 10px 0 0; }
	.error { color: var(--danger); font-size: var(--fs-xs); margin: 10px 0 0; }
</style>
