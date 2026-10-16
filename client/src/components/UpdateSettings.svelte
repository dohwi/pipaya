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
	<div class="label">{t("앱 업데이트")}</div>
	<div class="row">
		<span>{t("시작할 때 새 버전 확인")}</span>
		<Switch checked={updater.auto} label={t("시작할 때 새 버전 확인")} onchange={(on) => updater.setAuto(on)} />
	</div>
	<div class="row">
		<span class="status">
			{#if updater.phase === "available" || downloading}
				{t("새 버전 {version}을 사용할 수 있습니다", { version: updater.version })}
			{:else if updater.current}
				{t("현재 버전 {version}", { version: updater.current })}
			{/if}
		</span>
		{#if updater.phase === "available"}
			<button class="btn primary sm" onclick={() => updater.install()}>{t("업데이트")}</button>
		{:else}
			<button class="btn sm" disabled={checking || downloading || serverBusy} onclick={checkAll}>
				{checking || serverUpdater.phase === "checking" ? t("확인하는 중…") : t("업데이트 확인")}
			</button>
		{/if}
	</div>
	{#if updater.phase === "idle" && updater.current}
		<p class="hint">{t("최신 버전입니다")}</p>
	{/if}
	{#if updater.error}<p class="error" role="alert">{updater.error}</p>{/if}
	{#if serverStatus}
		<div class="row server">
			<span class="status">
				{#if serverUpdater.phase === "updating"}{t("서버를 업데이트하는 중…")}
				{:else if serverUpdater.phase === "restarting"}{t("서버가 다시 시작되기를 기다리는 중…")}
				{:else if serverStatus.available}{t("서버에 새 버전이 있습니다")}
				{:else}{t("서버가 이미 최신 버전입니다")}{/if}
			</span>
			{#if serverStatus.available}
				<button class="btn primary sm" disabled={serverBusy} onclick={updateServer}>{t("서버 업데이트")}</button>
			{/if}
		</div>
	{/if}
	{#if serverUpdater.error}<p class="error" role="alert">{serverUpdater.error}</p>{/if}
	<p class="hint">
		{android ? t("앱 안에서 내려받은 뒤 시스템 설치 화면이 열립니다. 설치를 한 번 확인해 주세요.") : t("업데이트는 서명을 확인한 뒤 설치하고 앱을 다시 시작합니다.")}
	</p>
{/if}

<style>
	.label { font-size: var(--fs-xs); font-weight: 600; margin-bottom: 12px; color: var(--text-dim); }
	.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: var(--fs-sm); }
	.row + .row { margin-top: 10px; }
	/* The text gives way (and wraps) so the button keeps its natural width instead of being squeezed until its label breaks. */
	.status { flex: 1 1 auto; min-width: 0; color: var(--text-dim); overflow-wrap: anywhere; }
	.row .btn { flex: none; white-space: nowrap; }
	.hint { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.6; margin: 10px 0 0; }
	.error { color: var(--danger); font-size: var(--fs-xs); margin: 10px 0 0; }
</style>
