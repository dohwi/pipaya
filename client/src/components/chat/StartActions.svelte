<script lang="ts">
	import Notice from "../ui/Notice.svelte";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";

	/** Under the empty conversation: a way to connect a model when there is none, and the `/` `@` hint. Folder and reopen
	    stay where they live (the where-chip above the composer, `/cd`, `/resume`); repeating them here was too much. */
	const noModel = $derived(!app.models.some((m) => m.configured));
</script>

<div class="start">
	{#if noModel && app.sessionsLoaded}
		<Notice tone="warn" icon="key">
			{t("사용할 수 있는 모델이 아직 없습니다.")}
			{#snippet action()}<button type="button" class="tap" onclick={() => app.openSettings("agent")}>{t("모델 연결")}</button>{/snippet}
		</Notice>
	{/if}
	<p class="hint">{t("/ 로 명령, @ 로 파일을 불러옵니다")}</p>
</div>

<style>
	.start {
		container-type: inline-size;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		margin-top: 16px;
		pointer-events: auto;
	}
	.start :global(.notice) {
		text-align: left;
		max-width: 100%;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-faint);
		line-height: 16px;
		word-break: keep-all;
		text-wrap: balance;
	}
</style>
