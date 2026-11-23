<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * One card row of a list dialog (a skill, an MCP server, an extension command): an optional leading control (a Switch),
	 * the text column and optional trailing actions. Replaces the `.item/.info/.line/.name/.path/.desc` rules that Skills,
	 * Commands and MCP each carried.
	 *
	 *  lead     leading control, top-aligned with the first text line (a 22px Switch against the 20px badge row)
	 *  title    the first line: the name followed by Badges (wraps on a narrow screen)
	 *  actions  trailing buttons on the title row, right-aligned; the lines under the title run beneath them (last row on a phone)
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
		/* the page colour and the strong border: a card must stand out on the dialog surface and on the grey settings group alike */
		background: var(--bg);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
	}
	.info {
		min-width: 0;
		flex: 1;
		transition: color var(--motion-fast) var(--ease);
	}
	/* a switched-off item steps its text down a colour instead of fading to 0.55, which took small badges and the path
	   line under it to 2.3:1: the name from --text to --text-faint at normal weight, so on and off still read apart at a
	   glance; the faint lines under it stay as they are. Badges keep their colours. The switch says "off": no "꺼짐" badge beside it. */
	.off .info {
		color: var(--text-faint);
	}
	.off .info :global(.name) {
		font-weight: 500;
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
		min-height: var(--row);
	}
	/* whole-pixel line boxes (the body's 1.55 would make 13px text 20.15px tall) so a list's height stays an integer */
	.item :global(.name) {
		font-size: var(--fs-sm);
		line-height: 20px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.item :global(.meta) {
		margin: 4px 0 0;
		font-size: var(--fs-2xs);
		line-height: 16px;
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.item :global(.desc) {
		margin: 8px 0 0;
		font-size: var(--fs-xs);
		line-height: 18px;
		color: var(--text);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	/* what the entry is (desc) and the facts about it (meta: path, model, limits) are two different things: a hairline between them */
	.item :global(.desc + .meta) {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}
	/* With actions the card is a grid: the actions sit on the title row only, and the lines under the title (desc, path)
	   run under them to the card's right edge. As a column of their own they left a dead strip under the buttons and
	   wrapped a path at half the card's width. `.info` dissolves (display: contents) so its lines are grid rows. */
	.item.act {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0 12px; /* no row gap: the lines keep their own 4 / 8px margins, as in the flex column they came from */
		align-items: start;
	}
	.item.act:not(:has(.lead)) {
		grid-template-columns: minmax(0, 1fr) auto;
	}
	.act .info {
		display: contents;
	}
	.act > .lead {
		grid-row: 1;
		grid-column: 1;
	}
	.act .line {
		grid-row: 1;
		grid-column: 2;
	}
	.act:not(:has(.lead)) .line {
		grid-column: 1;
	}
	.act > .side {
		grid-row: 1;
		grid-column: -2;
	}
	.act .info > :global(:not(.line)) {
		grid-column: 2 / -1;
	}
	.act:not(:has(.lead)) .info > :global(:not(.line)) {
		grid-column: 1 / -1;
	}
	/* A phone: the title row is too narrow for the name, its badges and two buttons, so the actions become the card's last
	   row, right-aligned like a dialog's footer, and the switch column keeps the text beside it. */
	@media (max-width: 640px) {
		.act {
			--row: 22px;
		}
		.act > .side {
			grid-row: auto;
			grid-column: 1 / -1;
			margin-top: 12px;
		}
	}
</style>
