<script lang="ts">
	import Backdrop, { arrival, type Burst } from "./Backdrop.svelte";
	import PipayaMark from "./PipayaMark.svelte";

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
			const delay = Math.round(arrival(b, Math.hypot(b.x - w / 2, b.y - h / 2)));
			glows.push({ id: b.id, delay });
			setTimeout(() => {
				glows = glows.filter((g) => g.id !== b.id);
				seen.delete(b.id);
			}, delay + GLOW + 100);
		}
	});
</script>

<Backdrop bind:bursts />
<div class="hello" aria-hidden="true" bind:clientWidth={w} bind:clientHeight={h}>
	<div class="base"><PipayaMark size={72} /></div>
	<!-- the colour mark: rises softly as the wave reaches it, stays a while, then fades out -->
	{#each glows as g (g.id)}
		<div class="tint" style="animation-delay:{g.delay}ms"><PipayaMark color size={72} /></div>
	{/each}
</div>

<style>
	.hello {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		pointer-events: none;
		user-select: none;
		color: var(--text-faint);
	}
	.hello > * {
		grid-area: 1 / 1;
	}
	.base {
		opacity: 0.35;
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
			opacity: 0.9;
		}
		60% {
			opacity: 0.9;
			animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
		}
		100% {
			opacity: 0;
		}
	}
</style>
