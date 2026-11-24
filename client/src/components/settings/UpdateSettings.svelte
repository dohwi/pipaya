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
				{#if updater.current}
					<span class="ver">{updater.current}{#if appNew && updater.version} → {updater.version}{/if}</span>
				{:else if appNew && updater.version}
					<span class="ver">{updater.version}</span>
				{/if}
				{#if downloading}
					<Badge tone="warn">{updater.phase === "ready" ? t("재시작하는 중…") : t("업데이트를 내려받는 중…")}</Badge>
				{:else if !appNew && updater.phase === "idle" && updater.current}
					<Badge>{t("최신 버전입니다")}</Badge>
				{/if}
			</div>
			<div class="actions">
				{#if updater.phase === "available"}
					<Button size="sm" variant="update" onclick={() => updater.install()}>{t("업데이트")}</Button>
				{:else if !downloading}
					<Button size="sm" disabled={checking} onclick={checkAll}>
						<svg class:spin={checking} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
						{checking ? t("확인하는 중…") : t("업데이트 확인")}
					</Button>
				{/if}
			</div>
		</div>
		{#if downloading}
			<div class="bar" in:collapseIn out:collapseOut role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(updater.progress * 100)}>
				<span style:width="{Math.round(updater.progress * 100)}%"></span>
			</div>
		{/if}
	</div>
	{#if updater.error}<div class="err-gap" in:collapseIn out:collapseOut><Notice tone="danger" size="sm" raised>{updater.error}</Notice></div>{/if}
	<p class="hint note">
		{android ? t("앱 안에서 내려받은 뒤 시스템 설치 화면이 열립니다. 설치를 한 번 확인해 주세요.") : t("업데이트는 서명을 확인한 뒤 설치하고 앱을 다시 시작합니다.")}
	</p>
{/if}

<style>
	/* borderless page-tinted surface inside .set-group (no box-in-box, matching ServerUpdate and ListItem) */
	.card { margin-top: 12px; background: var(--item-bg, var(--bg)); border-radius: var(--radius-sm); overflow: hidden; }
	.item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px; min-height: 56px; }
	.meta { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex: 1 1 120px; min-width: 0; }
	.name { font-size: var(--fs-sm); line-height: 20px; font-weight: 500; }
	.ver { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-xs); line-height: 16px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
	.actions { display: flex; justify-content: flex-end; margin-left: auto; }
	.actions :global(.btn) { flex: none; white-space: nowrap; }
	.actions :global(.btn svg) { width: 14px; height: 14px; }
	/* phones: stretch wrapped action full-width instead of floating right with dead left space */
	@media (max-width: 640px) {
		.actions { width: 100%; margin-left: 0; }
		.actions :global(.btn) { width: 100%; }
	}
	.bar { height: 3px; background: var(--border); }
	.bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-fast) var(--ease-std); }
	.err-gap { padding-top: 8px; }
	.note { line-height: 20px; margin: 8px 0 0; }
</style>
