<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import { app } from "../lib/store.svelte";

	const noModel = $derived(!app.models.some((m) => m.configured));
</script>

<div class="welcome">
	<div class="face" aria-hidden="true"><PipayaMark size={72} /></div>
	<div class="copy">
		<h1>{t("무엇을 함께 작업할까요?")}</h1>
		<p class="sub">{t("파일을 읽고, 수정하고, 명령을 실행합니다.")}</p>
	</div>

	{#if noModel && app.sessionsLoaded}
		<div class="warn">
			<Icon name="key" />
			<span>{t("사용할 수 있는 모델이 아직 없습니다.")}</span>
			<button class="btn sm" onclick={() => (app.connectionsOpen = true)}>{t("모델 연결")}</button>
		</div>
	{/if}
</div>

<style>
	.welcome {
		margin: auto;
		width: 100%;
		max-width: 680px;
		min-height: min(240px, 100%);
		padding: 16px 18px;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		animation: fade var(--motion-slow) var(--ease) both;
	}
	@keyframes fade {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
	}
	.face {
		position: relative;
		margin-bottom: 12px;
		color: var(--text-faint);
		opacity: 0.35;
		user-select: none;
	}
	.copy {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	h1 {
		text-wrap: balance;
		margin: 0;
		font-size: clamp(18px, 4vw, 22px);
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.15;
	}
	.sub {
		margin: 6px 0 0;
		font-size: var(--fs-sm);
		color: var(--text-dim);
		text-wrap: balance;
	}
	.warn {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: center;
		position: relative;
		margin-top: 16px;
		padding: 10px 14px;
		border-radius: var(--radius);
		background: var(--warn-soft);
		color: var(--warn);
		font-size: var(--fs-md);
	}
	.warn :global(svg) {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
