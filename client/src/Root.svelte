<script lang="ts">
	import App from "./App.svelte";
	import { t } from "./lib/i18n";
	import { copyText } from "./lib/clipboard";
	import { crashReport } from "./lib/crash-report";

	/** What "오류 정보 복사" puts on the clipboard: kept from the moment of the error (the stack names the broken part). */
	let report = "";
	let copied = $state<"" | "ok" | "fail">("");
	function caught(e: unknown) {
		console.error("app render error", e);
		report = crashReport(e, { at: Date.now(), url: location.href, userAgent: navigator.userAgent });
		copied = "";
	}
	async function copyReport() {
		copied = (await copyText(report)) ? "ok" : "fail";
	}
</script>

<!-- A render error anywhere would otherwise unmount the whole app and leave a blank window; offer a retry instead. -->
<svelte:boundary onerror={caught}>
	<App />
	{#snippet failed(error, reset)}
		<div class="crash" role="alert">
			<p>{t("화면을 그리다 문제가 생겼습니다")}</p>
			<small>{error instanceof Error ? error.message : String(error)}</small>
			<div class="row">
				<button type="button" onclick={reset}>{t("다시 시도")}</button>
				<button type="button" onclick={() => location.reload()}>{t("새로고침")}</button>
			</div>
			<!-- for a bug report: the error, its code and the top of the stack (no tokens: the page query is dropped) -->
			<button type="button" class="copy" onclick={copyReport}>{copied === "ok" ? t("복사됨") : copied === "fail" ? t("복사하지 못했습니다") : t("오류 정보 복사")}</button>
		</div>
	{/snippet}
</svelte:boundary>

<style>
	.crash { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100dvh; padding: 24px; text-align: center; background: var(--bg); color: var(--text); }
	.crash p { margin: 0; font-size: 16px; }
	.crash small { max-width: 480px; opacity: 0.7; word-break: break-word; }
	.row { display: flex; gap: 8px; }
	button { height: 40px; padding: 0 16px; border-radius: var(--radius-control, 10px); border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
	.copy { height: 32px; border: 0; opacity: 0.7; text-decoration: underline; }
</style>
