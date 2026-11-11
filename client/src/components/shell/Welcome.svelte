<script lang="ts">
	import StartActions from "../chat/StartActions.svelte";
	import { t } from "../../lib/i18n";
	import PipayaMark from "../ui/PipayaMark.svelte";
	import Backdrop, { arrival, type Burst } from "../ui/Backdrop.svelte";

	const GLOW = 1500; // ms, matches @keyframes glow
	let bursts: Burst[] = $state([]);
	let face: HTMLElement | undefined = $state();
	/** One colour mark per click, started for the moment its wave front reaches the mark (same as EmptyHero). */
	let glows: { id: number; delay: number }[] = $state([]);
	const seen = new Set<number>();

	$effect(() => {
		for (const b of bursts) {
			if (seen.has(b.id) || !face) continue;
			seen.add(b.id);
			const host = face.closest(".welcome")?.parentElement;
			const f = face.getBoundingClientRect();
			const h = host?.getBoundingClientRect();
			const cx = f.left + f.width / 2 - (h?.left ?? 0);
			const cy = f.top + f.height / 2 - (h?.top ?? 0);
			const delay = Math.round(arrival(b.reach, Math.hypot(b.x - cx, b.y - cy)));
			glows.push({ id: b.id, delay });
			setTimeout(() => {
				glows = glows.filter((g) => g.id !== b.id);
				seen.delete(b.id);
			}, delay + GLOW + 100);
		}
	});

</script>

<Backdrop bind:bursts />
<div class="welcome" data-part="welcome">
	<div class="face" aria-hidden="true" bind:this={face}>
		<div class="base"><PipayaMark size={72} /></div>
		{#each glows as g (g.id)}
			<div class="tint" style="animation-delay:{g.delay}ms"><PipayaMark color size={72} /></div>
		{/each}
	</div>
	<div class="copy">
		<h1>{t("무엇을 함께 작업할까요?")}</h1>
		<p class="sub">{t("파일을 읽고, 수정하고, 명령을 실행합니다.")}</p>
	</div>

	<StartActions />
</div>

<style>
	.welcome {
		margin: auto;
		width: 100%;
		max-width: 680px;
		min-height: min(240px, 100%);
		padding: 16px 16px;
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
		display: grid;
		user-select: none;
	}
	.face > * {
		grid-area: 1 / 1;
	}
	.base {
		/* solid colour (the old 35% fade of --text-faint, pre-mixed): the grid lines must not show through the mark */
		color: color-mix(in srgb, var(--text-faint) 35%, var(--bg));
	}
	.tint {
		opacity: 0;
		animation: glow 1500ms both;
	}
	@keyframes glow {
		0% {
			opacity: 0;
			animation-timing-function: cubic-bezier(0.3, 0, 0.2, 1);
		}
		25% {
			opacity: 1;
		}
		60% {
			opacity: 1;
			animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
		}
		100% {
			opacity: 0;
		}
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
		margin: 4px 0 0;
		font-size: var(--fs-sm);
		color: var(--text-dim);
		text-wrap: balance;
	}
</style>
