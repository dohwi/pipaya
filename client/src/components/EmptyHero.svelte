<script lang="ts">
	import Backdrop, { type Burst } from "./Backdrop.svelte";
	import PipayaMark from "./PipayaMark.svelte";

	let bursts: Burst[] = $state([]);
	let w = $state(0);
	let h = $state(0);

	const LEAD = 240; // px: the mark starts to glow this far before the wave front reaches it
	const TRAIL = 480; // px: and keeps fading this far behind it
	const soft = (t: number) => {
		const c = Math.min(1, Math.max(0, t));
		return c * c * (3 - 2 * c);
	};
	/** 0..1 glow of the centred mark for one wave: eases in as the front nears, eases out slowly behind it. */
	function glow(b: Burst): number {
		const behind = b.r - Math.hypot(b.x - w / 2, b.y - h / 2); // >0 once the front has passed the mark
		return (behind < 0 ? soft(1 + behind / LEAD) : soft(1 - behind / TRAIL)) * b.a;
	}
</script>

<Backdrop bind:bursts />
<div class="hello" aria-hidden="true" bind:clientWidth={w} bind:clientHeight={h}>
	<div class="base"><PipayaMark size={72} /></div>
	<!-- the colour mark glows softly while a wave is near, then fades out behind it -->
	{#each bursts as b (b.id)}
		<div class="tint" style="opacity:{(glow(b) * 0.9).toFixed(3)}"><PipayaMark color size={72} /></div>
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
</style>
