<script lang="ts">
	import Icon from "../ui/Icon.svelte";

	/**
	 * The round "x" on the top-right corner of something waiting in the composer (an image thumbnail, a file chip): a
	 * 22px badge in the text colour that hangs 6px over the corner. The parent is `position: relative`.
	 */
	let { label, onclick }: { label: string; onclick: () => void } = $props();
</script>

<button type="button" class="rm" {onclick} aria-label={label}><Icon name="x" /></button>

<style>
	.rm {
		position: absolute;
		top: -6px; /* hangs 6px over the item's top-right corner */
		right: -6px;
		width: 22px;
		height: 22px;
		border-radius: var(--radius);
		display: grid;
		place-items: center;
		background: var(--text);
		color: var(--bg);
	}
	.rm :global(svg) {
		width: 12px;
		height: 12px;
		stroke-width: 2.6;
	}
</style>
