<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { groupKey } from "../../lib/sidebar-model";
	import { isBrowserId, type BrowserTabInfo } from "../../lib/browser";
	import { isTerminalId, type TerminalInfo } from "../../lib/terminal";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { DropOpts } from "../../lib/dnd.svelte";
	import type { Group, Session } from "../../lib/types";
	import GroupRow from "./GroupRow.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";
	import BrowserRow from "./BrowserRow.svelte";

	/**
	 * A split tab in a folder: its header row and, unless folded, its panes on a tree line. Something dropped on a pane
	 * joins the group.
	 */
	let { n, g, members, drop }: { n: SidebarNode; g: Group; members: (Session | TerminalInfo | BrowserTabInfo)[]; drop: DropOpts } = $props();

	const sb = getSidebarCtx();
</script>

<div class="grp" class:over={sb.marks.over(g.id)}>
	<GroupRow {n} {g} {members} {drop} />
	{#if !sb.isFolded(groupKey(g.id))}
		<div class="members fold" in:collapseIn out:collapseOut>
			{#each members as m (m.id)}
				{#if isTerminalId(m.id)}
					<TerminalRow {n} x={m as TerminalInfo} drop={sb.memberTarget(n, m)} member />
				{:else if isBrowserId(m.id)}
					<BrowserRow {n} x={m as BrowserTabInfo} drop={sb.memberTarget(n, m)} member />
				{:else}
					<SessionRow {n} x={m as Session} drop={sb.memberTarget(n, m)} member />
				{/if}
			{/each}
		</div>
	{/if}
</div>
