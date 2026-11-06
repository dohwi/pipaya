<script lang="ts">
	import type { Snippet } from "svelte";
	import { app } from "../../lib/store.svelte";
	import { type DropOpts } from "../../lib/dnd.svelte";
	import { getSidebarCtx, type MenuTarget, type SidebarNode } from "../../lib/sidebar-ctx";
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
		trail,
	}: {
		n: SidebarNode;
		x: { id: string; title: string };
		target: MenuTarget;
		tip: string;
		drop: DropOpts;
		member?: boolean;
		body: Snippet<[boolean]>;
		/** A mark in the right-hand column left of the "more" button (x 236), e.g. the bell of a muted conversation */
		trail?: Snippet;
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
	<button class="open wide" onclick={() => app.openIn(n.server.id, { session: x.id })} title={tip}>
		{@render body(pinned)}
	</button>
	{@render trail?.()}
</RowShell>
