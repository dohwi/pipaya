<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { treePath } from "../../../lib/tree-path";
	import { groupKey } from "../../../lib/sidebar-model";
	import { isTerminalId, type TerminalInfo } from "../../../lib/terminal";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import type { DropOpts } from "../../../lib/dnd.svelte";
	import type { Group, Session } from "../../../lib/types";
	import GroupRow from "./GroupRow.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";

	/**
	 * A split tab in a folder: its header row and, unless folded, its panes on a tree line. Something dropped on a pane
	 * joins the group.
	 */
	let { n, g, members, drop }: { n: SidebarNode; g: Group; members: (Session | TerminalInfo)[]; drop: DropOpts } = $props();

	const sb = getSidebarCtx();
</script>

<div class="grp" class:over={sb.marks.over(g.id)}>
	<GroupRow {n} {g} {members} {drop} />
	{#if !sb.isFolded(groupKey(g.id))}
		<div class="members fold" in:collapseIn out:collapseOut use:treePath={{ row: ".item.active", lead: 2 }}>
			{#each members as m (m.id)}
				{#if isTerminalId(m.id)}
					<TerminalRow {n} x={m as TerminalInfo} drop={sb.memberTarget(n, m)} member />
				{:else}
					<SessionRow {n} x={m as Session} drop={sb.memberTarget(n, m)} member />
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	/* hairline between workspaces / groups */

	/* A split tab and its panes read as one tree: the book row on top, its panes hanging off a line under the book. */
	.grp {
		margin: 1px 0; /* full width like the other tabs, so the book sits where their icons do; 1px between rows like every other row */
		border-radius: var(--radius-sm);
	}
	.grp.over {
		background: var(--accent-soft);
	}
	/* the open pane's path: one element from the group down to its elbow, one step darker than the quiet rule. Only its height
	   moves (lib/tree-path), on the selection marker's time and curve, so the two travel together */
	.members {
		position: relative;
	}
	/* the quiet rules draw above the selection wash, so the open row no longer tints the rule that runs behind it */
	:global(:where(.side) .members .item .branch) {
		z-index: 2;
	}
	:global(:where(.side) .members .tree-path) {
		position: absolute;
		left: 50.25px; /* the rule's column: x 68 like .branch (46.25px from a row's left, x 21); .members starts 4px further left, at x 17 */
		top: -2px; /* up into the gap under the group row, where the first pane's rule starts */
		z-index: 3; /* above the rows' quiet rules (z 2, which overlap each other by 1px), which are above the selection wash (z 1) */
		width: 12px;
		height: var(--path-h, 0px); /* already counts the 2px lead above the first row (lib/tree-path) */
		box-sizing: border-box;
		border-left: 1.5px solid var(--text-dim);
		border-bottom: 1.5px solid var(--text-dim);
		border-bottom-left-radius: 3px;
		opacity: 1;
		pointer-events: none;
		transition: height var(--motion-normal) var(--ease), opacity var(--motion-fast) var(--ease-std);
	}
	:global(:where(.side) .members .tree-path[data-empty]) {
		opacity: 0;
	}
	:global(:where(.side) .members .item:last-child .branch::before) {
		bottom: calc(50% + 8px);
	}
	:global(:where(.side) .members .item:first-child .branch::before) {
		top: -2px; /* the first pane also reaches up into the gap under the book row */
	}
	/* a split tab being dragged takes its panes along */
	:global(:where(.side) .grp:has(> .item.carried) .members .item) {
		opacity: 0.45;
	}
</style>
