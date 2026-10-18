<script lang="ts">
	import Backdrop from "./Backdrop.svelte";
	import PipayaMark from "./PipayaMark.svelte";
</script>

<Backdrop />
<div class="hello" aria-hidden="true">
	<div class="base"><PipayaMark size={72} /></div>
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
