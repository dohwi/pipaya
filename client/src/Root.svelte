<script lang="ts">
	import App from "./App.svelte";
	import { t } from "./lib/i18n";
</script>

<!-- A render error anywhere would otherwise unmount the whole app and leave a blank window; offer a retry instead. -->
<svelte:boundary onerror={(e) => console.error("app render error", e)}>
	<App />
	{#snippet failed(error, reset)}
		<div class="crash" role="alert">
			<p>{t("화면을 그리다 문제가 생겼습니다")}</p>
			<small>{error instanceof Error ? error.message : String(error)}</small>
			<div class="row">
				<button type="button" onclick={reset}>{t("다시 시도")}</button>
				<button type="button" onclick={() => location.reload()}>{t("새로고침")}</button>
			</div>
		</div>
	{/snippet}
</svelte:boundary>

<style>
	.crash { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100dvh; padding: 24px; text-align: center; background: var(--bg); color: var(--text); }
	.crash p { margin: 0; font-size: 16px; }
	.crash small { max-width: 480px; opacity: 0.7; word-break: break-word; }
	.row { display: flex; gap: 8px; }
	button { height: 40px; padding: 0 16px; border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
</style>
