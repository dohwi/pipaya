<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../lib/activity";
	import { type DropOpts } from "../../lib/dnd.svelte";
	import { groupKey } from "../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Group, Session } from "../../lib/types";
	import type { TerminalInfo } from "../../lib/terminal";
	import Icon from "../Icon.svelte";
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
	<button class="open wide" onclick={() => (n.current ? app.openTab(g.id) : app.openIn(n.server.id, { session: members[0]!.id }))} ondblclick={() => n.current && sb.startGroupRename(g)} title={t("{name} · 더블 클릭으로 이름 바꾸기", { name: g.name })}>
		<span class="lead"><Icon name="group" /></span>
		<RowTitle text={g.name} />
		{#if pinned}<span class="tpin" title={t("고정됨")}><Icon name="pin" /></span>{/if}
		{#if folded}<span class="cbadge tint {ACTIVITY_TONE[gstate]}" title={t("{n}개", { n: members.length }) + (gstate !== "idle" ? ` · ${ACTIVITY_LABEL[gstate]}` : "")}>{members.length}</span>{/if}
	</button>
</RowShell>

<style>
	/* same pin mark as a lone tab's: the "⋯" column (centre x 256), given way to the "⋯" on hover */
	.open.wide:has(> .tpin) {
		padding-right: 0;
	}
	/* only where a pointer hovers: touch keeps the pin (its open row shows the "⋯" permanently, the pin sits beside it) and a tap's sticky :hover must not hide it */
	@media (hover: hover) {
		:global(.item:hover) .tpin,
		:global(.item:focus-within) .tpin,
		:global(.item.menuopen) .tpin {
			display: none;
		}
	}
	/* beside a folded group's count the pin sits on the list-button column (centre x 236): the open button's 4px gap would put it on 232, so it takes that gap back */
	.tpin:has(+ .cbadge) {
		margin-right: -4px;
	}
	.tpin {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		color: var(--text-faint);
	}
	.tpin :global(svg) {
		width: 14px;
		height: 14px;
		transform: rotate(35deg);
	}
</style>
