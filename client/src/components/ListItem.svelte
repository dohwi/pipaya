<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * One card row of a list dialog (a skill, an MCP server, an extension command): an optional leading control (a Switch),
	 * the text column and optional trailing actions. Replaces the `.item/.info/.line/.name/.path/.desc` rules that Skills,
	 * Commands and MCP each carried.
	 *
	 *  lead     leading control, top-aligned with the first text line (a 22px Switch against the 20px badge row)
	 *  title    the first line: the name followed by Badges (wraps on a narrow screen)
	 *  actions  trailing buttons, kept on one row, right-aligned (below the text on a phone)
	 *  off      fades the text column (a switched-off item)
	 *  children the lines under the title (`<p class="meta">`, `<p class="desc">` …)
	 * The row is a <div> inside the caller's keyed <li>: `animate:reflow` and `in:/out:` only work on the direct child of an
	 * {#each}, so a list that animates puts them on its own <li> and drops this component inside.
	 */
	let {
		off = false,
		lead,
		title,
		actions,
		children,
	}: { off?: boolean; lead?: Snippet; title: Snippet; actions?: Snippet; children?: Snippet } = $props();
</script>

<div class="item" class:off class:act={!!actions}>
	{#if lead}<span class="lead">{@render lead()}</span>{/if}
	<div class="info">
		<div class="line">{@render title()}</div>
		{@render children?.()}
	</div>
	{#if actions}<div class="side">{@render actions()}</div>{/if}
</div>

<style>
	.item {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.info {
		min-width: 0;
		flex: 1;
		transition: opacity var(--motion-fast) var(--ease);
	}
	.off .info {
		opacity: 0.55;
	}
	/* The first row (switch, title + badges, actions) shares one centre line: it is as tall as its tallest part, the 34px
	   action buttons, or the 22px switch when there are none. On a phone the actions drop below, so the row is 22px again. */
	.item {
		--row: 22px;
	}
	.act {
		--row: 34px;
	}
	.lead {
		flex: none;
		display: inline-flex;
		align-items: center;
		min-height: var(--row);
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		min-height: var(--row);
	}
	.side {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
		justify-content: flex-end;
	}
	.item :global(.name) {
		font-size: var(--fs-sm);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.item :global(.meta) {
		margin: 4px 0 0;
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.item :global(.desc) {
		margin: 4px 0 0;
		font-size: var(--fs-xs);
		line-height: 1.55;
		color: var(--text-dim);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	@media (max-width: 640px) {
		.item {
			flex-wrap: wrap;
		}
		.act {
			--row: 22px;
		}
		.side {
			width: 100%;
			justify-content: flex-start;
		}
	}
</style>
