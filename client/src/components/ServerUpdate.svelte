<script lang="ts">
	import { t } from "../lib/i18n";
	import { updater } from "../lib/updater.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";
	import { app } from "../lib/store.svelte";
	import { serverReleaseState } from "../lib/protocol";
	import { collapseIn, collapseOut } from "../lib/motion";

	/** Only the server the app is connected to can be asked: it is the one `updater.connection` talks to. */
	const busy = $derived(serverUpdater.busy);
	const status = $derived(serverUpdater.status?.managed ? serverUpdater.status : null);
	const version = $derived(app.serverVersions?.version ?? "");
	/** Without a git status (not self-updating, or the fetch failed) compare the release with the app's: they ship together. */
	const release = $derived(serverReleaseState(version, updater.current));
	const isNew = $derived(Boolean(status?.available));
	const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

	async function check() {
		const conn = updater.connection?.();
		if (conn?.api && conn.serverId) await serverUpdater.check(conn.api, conn.serverId, true);
	}

	async function update() {
		const api = updater.connection?.().api;
		if (!api) return;
		if (await serverUpdater.apply(api)) {
			app.toast(t("서버를 업데이트했습니다"), "ok");
			await app.sync();
		}
	}
</script>

{#if status || version}
	<div class="head">
		<div class="label">{t("서버 버전")}</div>
		<button class="btn sm" disabled={busy} onclick={check}>
			<svg class:spin={serverUpdater.phase === "checking"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
			{serverUpdater.phase === "checking" ? t("확인하는 중…") : t("업데이트 확인")}
		</button>
	</div>
	<div class="item">
		<div class="meta">
			{#if version || status?.current}
				<span class="ver">
					{[version, short(status?.current)].filter(Boolean).join(" · ")}{#if isNew && status?.latest} → {short(status.latest)}{/if}
				</span>
			{/if}
		</div>
		{#if serverUpdater.phase === "updating"}
			<span class="chip new"><i></i>{t("서버를 업데이트하는 중…")}</span>
		{:else if serverUpdater.phase === "restarting"}
			<span class="chip new"><i></i>{t("서버가 다시 시작되기를 기다리는 중…")}</span>
		{:else if isNew}
			<span class="chip new"><i></i>{t("서버에 새 버전이 있습니다")}</span>
		{:else if release === "older"}
			<span class="chip new"><i></i>{t("앱보다 오래된 버전입니다")}</span>
		{:else if status || release === "current"}
			<span class="chip ok"><i></i>{t("최신 버전입니다")}</span>
		{/if}
		{#if isNew}
			<button class="btn primary sm" disabled={busy} onclick={update}>{t("서버 업데이트")}</button>
		{/if}
	</div>
	{#if release === "older" && !isNew && !busy}
		<p class="hint" in:collapseIn out:collapseOut>{t("서버가 앱보다 오래된 버전입니다. 서버에서 업데이트를 실행하세요 (install.sh update)")}</p>
	{/if}
	{#if serverUpdater.error}<p class="error" role="alert" in:collapseIn out:collapseOut>{serverUpdater.error}</p>{/if}
{/if}

<style>
	.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
	.label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-dim); }
	.head .btn { flex: none; white-space: nowrap; }
	.head .btn svg { width: 14px; height: 14px; }
	.spin { animation: spin 0.9s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
	.item { display: flex; align-items: center; gap: 10px; padding: 12px 14px; min-height: 56px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); }
	.meta { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
	.ver { font-size: var(--fs-sm); color: var(--text); font-variant-numeric: tabular-nums; }
	.chip { flex: 0 1 auto; font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-pill); font-size: var(--fs-xs); line-height: 1.5; text-align: right; }
	.chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
	.chip.ok { background: var(--ok-soft); color: var(--ok); }
	.chip.new { background: var(--warn-soft); color: var(--warn); }
	.item .btn { flex: none; white-space: nowrap; }
	.hint { font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.6; margin: 10px 0 0; }
	.error { color: var(--danger); font-size: var(--fs-xs); margin: 10px 0 0; }
</style>
