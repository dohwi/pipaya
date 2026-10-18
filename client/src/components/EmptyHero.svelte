<script lang="ts">
	import Backdrop, { type Burst } from "./Backdrop.svelte";
	import PipayaMark from "./PipayaMark.svelte";

	let bursts: Burst[] = $state([]);
</script>

<Backdrop bind:bursts />
<div class="hello" aria-hidden="true">
	<div class="base"><PipayaMark size={72} /></div>
	<!-- the colour mark, shown only through the same ring as the grid wave, so it lights up as the wave passes -->
	{#each bursts as b (b.id)}
		<div class="tint" style="--cx:{b.x}px;--cy:{b.y}px;--r:{b.r.toFixed(1)}px;opacity:{b.a.toFixed(3)}">
			<PipayaMark color size={72} />
		</div>
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
	/* fills the whole area so the mask coordinates match the backdrop's */
	.tint {
		place-self: stretch;
		display: grid;
		place-items: center;
		--mask: radial-gradient(circle at var(--cx) var(--cy), transparent calc(var(--r) - 220px), #000 calc(var(--r) - 40px), transparent var(--r));
		-webkit-mask-image: var(--mask);
		mask-image: var(--mask);
	}
</style>
