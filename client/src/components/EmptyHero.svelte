<script lang="ts">
	import Backdrop, { arrival, type Burst } from "./Backdrop.svelte";
	import PipayaMark from "./PipayaMark.svelte";
	import StartActions from "./StartActions.svelte";

	const GLOW = 1500; // ms: from the wave reaching the mark until it has fully faded again (see @keyframes glow)
	let bursts: Burst[] = $state([]);
	let w = $state(0);
	let h = $state(0);
	/** One colour mark per click, each started (animation-delay) for the moment its wave front reaches the mark. */
	let glows: { id: number; delay: number }[] = $state([]);
	const seen = new Set<number>();

	$effect(() => {
		for (const b of bursts) {
			if (seen.has(b.id)) continue;
			seen.add(b.id);
			const delay = Math.round(arrival(b.reach, Math.hypot(b.x - w / 2, b.y - h / 2)));
			glows.push({ id: b.id, delay });
			setTimeout(() => {
				glows = glows.filter((g) => g.id !== b.id);
				seen.delete(b.id);
			}, delay + GLOW + 100);
		}
	});
</script>

<Backdrop bind:bursts />
<div class="hello" bind:clientWidth={w} bind:clientHeight={h}>
	<div class="face" aria-hidden="true">
	<div class="base"><PipayaMark size={72} /></div>
	<!-- the colour mark: rises softly as the wave reaches it, stays a while, then fades out -->
	{#each glows as g (g.id)}
		<div class="tint" style="animation-delay:{g.delay}ms"><PipayaMark color size={72} /></div>
	{/each}
	</div>
	<StartActions />
</div>

<style>
	.hello {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 16px;
		pointer-events: none;
		user-select: none;
		color: var(--text-faint);
	}
	.face {
		display: grid;
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
</style>
