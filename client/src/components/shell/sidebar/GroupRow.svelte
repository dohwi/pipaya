<script lang="ts">
	import { app } from "../../../lib/store.svelte";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { type DropOpts } from "../../../lib/dnd.svelte";
	import { groupKey } from "../../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import type { Group, Session } from "../../../lib/types";
	import type { TerminalInfo } from "../../../lib/terminal";
	import Icon from "../../ui/Icon.svelte";
	import PinMark from "../../ui/PinMark.svelte";
	import RowOpen from "./RowOpen.svelte";
	import RowShell from "./RowShell.svelte";
	import RowTitle from "./RowTitle.svelte";

	/**
	 * The header of a split tab (group): a chevron that opens / closes it, the split icon, its name, the number of panes while folded, then
	 * the menu. The panes themselves hang under it on a tree line and are rendered by the caller (`children`).
	 */
	let {
		n,
		g,
		members,
		drop,
	}: {
		n: SidebarNode;
		g: Group;
		members: (Session | TerminalInfo)[];
		drop: DropOpts;
	} = $props();

	const sb = getSidebarCtx();
	const folded = $derived(sb.isFolded(groupKey(g.id)));
	const pinned = $derived(app.sidebar.isTabPinned(n.server.id, g.id));
	const gstate = $derived(mostUrgent(members.map((m) => sb.stateOfId(n, m.id))));
</script>

<RowShell
	id={g.id}
	current={n.current}
	renaming={sb.groupRename.is(g.id)}
	draft={sb.groupRename.draft}
	ondraft={(v) => (sb.groupRename.draft = v)}
	oncommit={() => sb.commitGroupRename()}
	oncancel={() => sb.groupRename.cancel()}
	target={{ kind: "group", g }}
	{drop}
	maxlength={100}
	class={["grprow", folded && "gfolded", n.current && g.id === app.activeGroup?.id && "cur"]}
>
	<button class="gfold" onclick={() => app.sidebar.toggleFolded(groupKey(g.id))} aria-expanded={!folded} aria-label={folded ? t("펼치기") : t("접기")} title={folded ? t("펼치기") : t("접기")}>
		<span class="chev" class:folded><Icon name="chevron-down" /></span>
	</button>
	<RowOpen renaming={n.current && sb.groupRename.is(g.id)} onopen={() => (n.current ? app.openTab(g.id) : app.openIn(n.server.id, { session: members[0]!.id }))} title={g.name}>
		<span class="lead"><Icon name="group" />{#if pinned}<PinMark />{/if}</span>
		<RowTitle text={g.name} />
		{#if folded}<span class="cbadge tint {ACTIVITY_TONE[gstate]}" title={t("{n}개", { n: members.length }) + (gstate !== "idle" ? ` · ${ACTIVITY_LABEL[gstate]}` : "")}>{members.length}</span>{/if}
	</RowOpen>
</RowShell>

<style>
	.gfold {
		flex: none;
		display: grid;
		place-items: center;
		width: 14px;
		height: 24px;
		margin-left: 21px; /* measured: puts the 14px chevron on the folder icon's column (x 48) */
		border-radius: var(--radius-sm);
	}
	:global(:where(.side) .grprow.cur .title) {
		font-weight: 600;
	}
	:global(:where(.side) .grprow .lead) {
		width: 16px; /* the tabs' icon column (16px), so the book icon and the name line up with theirs */
	}
	:global(:where(.side) .gfold:hover .chev svg) {
		stroke: var(--text);
	}
	/* a folded row has no button beside its count, so the toggle gives up its 8px right inset: the count lands on the list button's
	   column (x 236 on touch, where the "+" keeps x 256) instead of 8px short of it — measured */
	:global(:where(.side) .grprow.gfolded .open:not(.acc):not(.chev)) {
		padding-right: 0;
	}
	@media (pointer: coarse) {
	/* touch, folded split tab: its "⋯" only shows while the tab is open, so the count would land on x 256 when it is not; it keeps
	   the list button's column (x 236, like a folder's count) either way — 20 from the row's end puts its centre there */
	:global(:where(.side) .grprow.gfolded .cbadge) {
		position: absolute;
		inset-block: 0;
		margin-block: auto;
		right: 28px; /* 20 for the count's centre on x 236 plus the row's own 8px highlight bleed */
	}
	:global(:where(.side) .grprow.gfolded .open:not(.acc):not(.chev)) {
		padding-right: 40px; /* room for that count: the title ends where the pill starts */
	}
	}
	@media (hover: hover) {
	:global(:where(.side) .grprow.gfolded .acts) {
		position: absolute;
		top: 50%;
		right: 8px; /* the row's own right padding: keeps the "⋯" on x 256 */
		translate: 0 -50%;
	}
	:global(:where(.side) .grprow.gfolded .cbadge) {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	:global(:where(.side) .grprow.gfolded:hover .cbadge),
	:global(:where(.side) .grprow.gfolded:has(:focus-visible) .cbadge),
	:global(:where(.side) .grprow.gfolded.menuopen .cbadge) {
		opacity: 0;
	}
	}
</style>
