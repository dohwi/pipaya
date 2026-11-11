<script lang="ts">
	import type { Snippet } from "svelte";
	import { app } from "../../../lib/store.svelte";
	import { type DropOpts } from "../../../lib/dnd.svelte";
	import { getSidebarCtx, type MenuTarget, type SidebarNode } from "../../../lib/sidebar-ctx";
	import RowOpen from "./RowOpen.svelte";
	import RowShell from "./RowShell.svelte";

	/**
	 * One tab of a folder: a conversation or a terminal (a split tab's header is `GroupRow`). The `body` fills the open
	 * button (icon, label, title); `tip` is its tooltip. A `member` is a pane inside a split tab and hangs off its tree line.
	 * What rows share (the open menu, drag highlights, renaming) comes from the sidebar's context.
	 */
	let {
		n,
		x,
		target,
		tip,
		drop,
		member = false,
		body,
	}: {
		n: SidebarNode;
		x: { id: string; title: string };
		target: MenuTarget;
		tip: string;
		drop: DropOpts;
		member?: boolean;
		body: Snippet<[boolean]>;
	} = $props();

	const sb = getSidebarCtx();
	/** A pinned tab sits at the top of its folder; the panes of a split tab are pinned with it, so only a lone tab shows the mark */
	const pinned = $derived(!member && app.sidebar.isTabPinned(n.server.id, x.id));
</script>

<RowShell
	id={x.id}
	current={n.current}
	renaming={sb.rename.is(x.id)}
	draft={sb.rename.draft}
	ondraft={(v) => (sb.rename.draft = v)}
	oncommit={() => sb.commitRename()}
	oncancel={() => sb.rename.cancel()}
	{target}
	{drop}
	over={sb.marks.over(x.id)}
	{member}
	class={["tab", target.kind === "terminal" && "term", member && "member", n.current && x.id === app.activeId && "active"]}
>
	{#if member}<span class="branch" aria-hidden="true"></span>{/if}
	<RowOpen renaming={n.current && sb.rename.is(x.id)} onopen={() => app.openIn(n.server.id, { session: x.id })} title={tip}>
		{@render body(pinned)}
	</RowOpen>
</RowShell>

<style>
	/* tree line: a rule down from the book's centre; each pane gets a short elbow with a 3px corner (near right angle) (the last one ends the rule) */
	.branch {
		position: absolute;
		left: 46.25px; /* the 1.5px stroke's centre (x 21 + 46.25 + 0.75) sits on the book icon's column, x 68 */
		top: 0;
		bottom: 0;
		width: 12px;
		pointer-events: none;
	}
	.branch::before {
		content: "";
		position: absolute;
		left: 0;
		top: -1px; /* rows are 1px apart (their margin): run the rule across that gap so it never breaks */
		bottom: -1px;
		border-left: 1.5px solid var(--tree-line);
	}
	.branch::after {
		content: "";
		position: absolute;
		left: 0;
		top: calc(50% - 8px);
		width: 100%;
		height: 8px;
		border-left: 1.5px solid var(--tree-line);
		border-bottom: 1.5px solid var(--tree-line);
		border-bottom-left-radius: 3px;
	}
</style>
