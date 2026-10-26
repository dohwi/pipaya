<script lang="ts">
	import Button from "./Button.svelte";
	import Notice from "./Notice.svelte";
	import { t } from "../lib/i18n";
	import { app } from "../lib/store.svelte";
	import { IMAGE_RUNNER_EXTENSION } from "../lib/model-runners";

	/**
	 * Above the composer when the chat's model is an image model this server cannot run: say why nothing can be sent
	 * and offer the extension that runs it, or another model.
	 */
</script>

<div class="runner">
	<Notice tone="warn" size="sm">
		{t("이미지 모델은 서버에 이미지 생성 확장이 있어야 쓸 수 있습니다.")}
		{#snippet action()}
			<Button size="sm" variant="primary" onclick={() => app.openMarketFor(IMAGE_RUNNER_EXTENSION)}>{t("확장 설치")}</Button>
			<Button size="sm" onclick={() => app.modelPickerTick++}>{t("모델 바꾸기")}</Button>
		{/snippet}
	</Notice>
</div>

<style>
	.runner {
		margin: 0 0 8px;
	}
	.runner :global(.action) {
		display: inline-flex;
		gap: 6px;
	}
</style>
