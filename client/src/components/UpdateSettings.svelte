<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { updater } from "../lib/updater.svelte";
	import { notificationPlatform } from "../lib/notifications";
	import Switch from "./Switch.svelte";
	import SettingRow from "./SettingRow.svelte";
	import UpdateHeader from "./UpdateHeader.svelte";
	import StatusChip from "./StatusChip.svelte";
	import { collapseIn, collapseOut } from "../lib/motion";

	const android = notificationPlatform() === "android";
	const checking = $derived(updater.phase === "checking");
	const downloading = $derived(updater.phase === "downloading" || updater.phase === "ready");
	function checkAll() {
		return updater.check(true);
	}
</script>

{#if updater.supported}
	{@const appNew = updater.phase === "available" || downloading}
	<UpdateHeader label={t("앱 업데이트")} {checking} disabled={checking || downloading} onclick={checkAll} />
	<SettingRow label={t("시작할 때 새 버전 확인")}>
		<Switch checked={updater.auto} label={t("시작할 때 새 버전 확인")} onchange={(on) => updater.setAuto(on)} />
	</SettingRow>
	<div class="card">
		<div class="item">
			<div class="meta">
				<span class="name">{t("앱")}</span>
				{#if updater.current}<span class="ver">{updater.current}</span>{/if}
			</div>
			{#if appNew}
				<StatusChip tone="ok">{t("새 버전 {version}을 사용할 수 있습니다", { version: updater.version })}</StatusChip>
			{:else if updater.phase === "idle" && updater.current}
				<StatusChip tone="neutral">{t("최신 버전입니다")}</StatusChip>
			{/if}
			{#if updater.phase === "available"}
				<Button size="sm" class="update" onclick={() => updater.install()}>{t("업데이트")}</Button>
			{/if}
		</div>
		{#if downloading}
			<div class="bar" in:collapseIn out:collapseOut role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(updater.progress * 100)}>
				<span style:width="{Math.round(updater.progress * 100)}%"></span>
			</div>
		{/if}
	</div>
	{#if updater.error}<p class="hint danger err" role="alert" in:collapseIn out:collapseOut>{updater.error}</p>{/if}
	<p class="hint note">
		{android ? t("앱 안에서 내려받은 뒤 시스템 설치 화면이 열립니다. 설치를 한 번 확인해 주세요.") : t("업데이트는 서명을 확인한 뒤 설치하고 앱을 다시 시작합니다.")}
	</p>
{/if}

<style>
	.card { margin-top: 12px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.item { display: flex; align-items: center; gap: 10px; padding: 12px 14px; min-height: 56px; }
	.meta { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
	.name { font-size: var(--fs-sm); font-weight: 500; }
	.ver { font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
	.item :global(.btn) { flex: none; white-space: nowrap; }
	.bar { height: 3px; background: var(--border); }
	.bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-fast) var(--ease-std); }
	.note { line-height: 1.6; }
	.note, .err { margin: 10px 0 0; }
</style>
