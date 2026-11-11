<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The one dialog footer: the buttons on the dialog's gutters (`--dlg-px`), `--dlg-foot-t` above and `--dlg-foot-b` below,
	 * `start` on the left (a delete, a checkbox) and `children` pushed to the right (cancel, then the main action last).
	 *
	 *  above    a full-width line over the buttons (a form error), 8px above them
	 *  rule     a hairline above it, for a body that scrolls right up to it
	 *  safe     add the home-indicator inset below it (a phone sheet whose Modal does not pad it with `safeArea`)
	 *  compact  the tighter 8 / 16 spacing of a picker stacked over another dialog (its header is `compact` too)
	 *  wrap     let the buttons wrap onto a second line on a narrow screen instead of squeezing
	 */
	let {
		rule = false,
		safe = false,
		compact = false,
		wrap = false,
		above,
		start,
		children,
	}: { rule?: boolean; safe?: boolean; compact?: boolean; wrap?: boolean; above?: Snippet; start?: Snippet; children: Snippet } = $props();
</script>

{#snippet buttons()}
	{@render start?.()}
	<span class="grow"></span>
	{@render children()}
{/snippet}

<footer class="df" class:rule class:safe class:compact class:wrap class:stack={!!above}>
	{#if above}
		{@render above()}
		<div class="df-row">{@render buttons()}</div>
	{:else}
		{@render buttons()}
	{/if}
</footer>

<style>
	.df,
	.df-row {
		display: flex;
		align-items: center;
		gap: var(--dlg-gap-sm);
	}
	.df {
		flex: none;
		padding: var(--dlg-foot-t) var(--dlg-px) var(--dlg-foot-b);
	}
	.stack {
		flex-direction: column;
		align-items: stretch;
	}
	.safe {
		padding-bottom: calc(var(--dlg-foot-b) + var(--sab));
	}
	.compact {
		padding: 8px 16px;
	}
	.compact.safe {
		padding-bottom: calc(8px + var(--sab));
	}
	.rule {
		border-top: 1px solid var(--border);
	}
	.wrap,
	.wrap .df-row {
		flex-wrap: wrap;
	}
	.grow {
		flex: 1;
	}
</style>
