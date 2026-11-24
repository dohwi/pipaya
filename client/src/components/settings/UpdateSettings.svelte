<script lang="ts">
	import Notice from "../ui/Notice.svelte";
	import Button from "../ui/Button.svelte";
	import { t } from "../../lib/i18n";
	import { updater } from "../../lib/updater.svelte";
	import { notificationPlatform } from "../../lib/notifications";
	import Switch from "../ui/Switch.svelte";
	import SettingRow from "../ui/SettingRow.svelte";
	import Badge from "../ui/Badge.svelte";
	import { collapseIn, collapseOut } from "../../lib/motion";

	const android = notificationPlatform() === "android";
	const checking = $derived(updater.phase === "checking");
	const downloading = $derived(updater.phase === "downloading" || updater.phase === "ready");
	function checkAll() {
		return updater.check(true);
	}
</script>

{#if updater.supported}
	{@const appNew = updater.phase === "available" || downloading}
	<div class="section-label head">{t("앱 업데이트")}</div>
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
				<Badge tone="ok">{t("새 버전 {version}", { version: updater.version })}</Badge>
			{:else if updater.phase === "idle" && updater.current}
				<Badge>{t("최신 버전입니다")}</Badge>
			{/if}
			{#if updater.phase === "available"}
				<Button size="sm" variant="update" onclick={() => updater.install()}>{t("업데이트")}</Button>
			{:else if !downloading}
				<Button size="sm" disabled={checking} onclick={checkAll}>
					<svg class:spin={checking} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
					{checking ? t("확인하는 중…") : t("업데이트 확인")}
				</Button>
			{/if}
		</div>
		{#if downloading}
			<div class="bar" in:collapseIn out:collapseOut role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(updater.progress * 100)}>
				<span style:width="{Math.round(updater.progress * 100)}%"></span>
			</div>
		{/if}
	</div>
	{#if updater.error}<Notice tone="danger" size="sm" animated>{updater.error}</Notice>{/if}
	<p class="hint note">
		{android ? t("앱 안에서 내려받은 뒤 시스템 설치 화면이 열립니다. 설치를 한 번 확인해 주세요.") : t("업데이트는 서명을 확인한 뒤 설치하고 앱을 다시 시작합니다.")}
	</p>
{/if}

<style>
	.card { margin-top: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.item { display: flex; align-items: center; gap: 8px; padding: 12px 12px; min-height: 56px; }
	.meta { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: max-content; }
	.name { font-size: var(--fs-sm); line-height: 20px; font-weight: 500; }
	.ver { white-space: nowrap; font-size: var(--fs-xs); line-height: 16px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
	.item :global(.btn) { flex: none; white-space: nowrap; }
	.bar { height: 3px; background: var(--border); }
	.bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-fast) var(--ease-std); }
	.note { line-height: 1.6; }
	.note { margin: 8px 0 0; }
</style>
