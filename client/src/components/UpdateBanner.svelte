<script lang="ts">
	import Button from "./Button.svelte";
	import { t } from "../lib/i18n";
	import { updater } from "../lib/updater.svelte";
	import { notificationPlatform } from "../lib/notifications";
	import Icon from "./Icon.svelte";
	import Modal from "./Modal.svelte";
	import Switch from "./Switch.svelte";
	import { serverUpdater } from "../lib/server-update.svelte";

	const android = notificationPlatform() === "android";
	const downloading = $derived(updater.phase === "downloading" || updater.phase === "ready");
	const allowing = $derived(updater.phase === "ready-install");
	const percent = $derived(Math.round(updater.progress * 100));
	// while downloading, a click outside or Esc must not hide the only sign that something is being installed
	const closable = $derived(!downloading);
	const serverBusy = $derived(serverUpdater.phase === "updating" || serverUpdater.phase === "restarting");
</script>

{#if updater.visible}
	<Modal onclose={() => updater.dismiss()} dismissible={closable} label={t("업데이트")} live="polite" width="360px" gutter="32px" layer={4} sheet={false}>
	<div class="card">
		<div class="mark"><Icon name="download" /></div>
		<h2>
			{#if allowing}{t("설치를 허용해 주세요")}
			{:else if serverBusy}{serverUpdater.phase === "restarting" ? t("서버가 다시 시작되기를 기다리는 중…") : t("서버를 업데이트하는 중…")}
			{:else if updater.phase === "ready"}{t("재시작하는 중…")}
			{:else if downloading}{t("업데이트를 내려받는 중…")}
			{:else}{t("새 버전을 사용할 수 있습니다")}{/if}
		</h2>
		<p class="ver">
			{#if updater.current}<span class="mono">{updater.current}</span><span class="arrow" aria-hidden="true">→</span>{/if}
			<b class="mono">{updater.version}</b>
		</p>
		{#if allowing}
			<p class="note">{t("설정에서 이 앱의 설치를 허용하고 돌아오면 설치 화면이 이어서 열립니다.")}</p>
			<div class="actions"><Button onclick={() => updater.dismiss()}>{t("나중에")}</Button></div>
		{:else if downloading}
			<progress class="bar" max="100" value={updater.progress ? percent : undefined} aria-label={t("업데이트 진행률")}></progress>
			{#if updater.phase === "downloading" && updater.progress}<p class="pct">{percent}%</p>{/if}
		{:else}
			{#if updater.serverOffer}
				<div class="with-server">
					<span>{t("서버도 함께 업데이트")}</span>
					<Switch checked={serverUpdater.withApp} label={t("서버도 함께 업데이트")} onchange={(on) => serverUpdater.setWithApp(on)} />
				</div>
				<p class="note">{t("서버를 먼저 업데이트하고 다시 시작한 뒤 앱을 업데이트합니다. 실행 중인 대화가 있으면 서버는 건너뜁니다.")}</p>
			{/if}
			{#if updater.serverStep === "failed" && serverUpdater.error}<p class="note warn" role="alert">{serverUpdater.error}</p>{/if}
			<p class="note">{android ? t("앱 안에서 내려받은 뒤 시스템 설치 화면이 열립니다. 설치를 한 번 확인해 주세요.") : t("업데이트는 서명을 확인한 뒤 설치하고 앱을 다시 시작합니다.")}</p>
			<div class="actions">
				<Button onclick={() => updater.dismiss()}>{t("나중에")}</Button>
				<Button class="update" onclick={() => updater.install()}>{t("업데이트")}</Button>
			</div>
		{/if}
	</div>
	</Modal>
{/if}

<style>
	/* same shape as the server-link card: a small centred dialog above everything else */
	.card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 30px 24px 24px;
		text-align: center;
	}
	.mark {
		width: 64px;
		height: 64px;
		display: grid;
		place-items: center;
		border-radius: var(--radius);
		border: 1px solid var(--ok);
		background: var(--bg);
		color: var(--ok);
	}
	.mark :global(svg) {

		width: 28px;

		height: 28px;

		stroke-width: 2;

	}
	h2 {
		margin: 4px 0 0;
		font-size: var(--fs-xl);
	}
	.ver {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-md);
		color: var(--text-dim);
	}
	.ver b {
		color: var(--text);
	}
	.arrow {
		color: var(--text-faint);
	}
	.note {
		margin: 2px 0 6px;
		font-size: var(--fs-sm);
		line-height: 1.55;
		color: var(--text-faint);
		word-break: keep-all;
	}
	.with-server {
		align-self: stretch;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 4px;
		font-size: var(--fs-sm);
		color: var(--text);
	}
	.warn {
		color: var(--danger);
	}
	.actions {
		display: flex;
		gap: 8px;
		justify-content: center;
	}
	.bar {
		width: 100%;
		height: 6px;
		margin-top: 6px;
	}
	.pct {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
</style>
