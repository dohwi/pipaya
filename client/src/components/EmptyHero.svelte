<script lang="ts">
	import Backdrop from "./Backdrop.svelte";
	import PipayaMark from "./PipayaMark.svelte";

	/** Bumped on each click in the empty area: replays the colour flow over the mark. */
	let flow = $state(0);
</script>

<Backdrop onburst={() => (flow += 1)} />
<div class="hello" aria-hidden="true">
	<div class="base"><PipayaMark size={72} /></div>
	{#key flow}
		{#if flow > 0}<div class="tint"><PipayaMark color size={72} /></div>{/if}
	{/key}
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
	/* the colour version flows across the mark left to right, then drains away */
	.tint {
		-webkit-mask-image: linear-gradient(100deg, #000 40%, transparent 60%);
		mask-image: linear-gradient(100deg, #000 40%, transparent 60%);
		-webkit-mask-size: 300% 100%;
		mask-size: 300% 100%;
		animation: flow 1.4s cubic-bezier(0.4, 0.1, 0.3, 1) forwards;
	}
	@keyframes flow {
		0% {
			-webkit-mask-position: 100% 0;
			mask-position: 100% 0;
			opacity: 1;
			filter: hue-rotate(-40deg) saturate(1.4);
		}
		60% {
			opacity: 1;
		}
		100% {
			-webkit-mask-position: 0 0;
			mask-position: 0 0;
			opacity: 0;
			filter: hue-rotate(40deg) saturate(1.4);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.tint {
			display: none;
		}
	}
</style>
