<script lang="ts">
	let { size = 14 }: { size?: number } = $props();
</script>

<span class="wm" style="font-size:{size}px"><span class="a">pipaya</span></span>

<style>
	.wm {
		display: inline-flex;
		align-items: baseline;
		font-family: var(--mono);
		font-weight: 600;
		letter-spacing: -0.045em;
		line-height: 1;
		white-space: nowrap;
	}
	.a {
		color: var(--text);
	}
</style>
