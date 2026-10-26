<script lang="ts">
	import { app } from "../../lib/store.svelte";
	import { t } from "../../lib/i18n";
	import { type DropOpts } from "../../lib/dnd.svelte";
	import { groupKey } from "../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Group, Session } from "../../lib/types";
	import type { TerminalInfo } from "../../lib/terminal";
	import type { BrowserTabInfo } from "../../lib/browser";
	import Icon from "../Icon.svelte";
	import RowShell from "./RowShell.svelte";
	import RowTitle from "./RowTitle.svelte";

	/**
	 * The header of a split tab (group): a book that opens / closes it, its name, the number of panes while folded, then
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
		members: (Session | TerminalInfo | BrowserTabInfo)[];
		drop: DropOpts;
	} = $props();

	const sb = getSidebarCtx();
	const folded = $derived(sb.isFolded(groupKey(g.id)));
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
	class={["grprow", n.current && g.id === app.activeGroup?.id && "cur"]}
>
	<button class="gfold" onclick={() => app.sidebar.toggleFolded(groupKey(g.id))} aria-expanded={!folded} aria-label={folded ? t("펼치기") : t("접기")} title={folded ? t("펼치기") : t("접기")}>
		<Icon name={folded ? "group" : "group-open"} />
	</button>
	<button class="open wide" onclick={() => (n.current ? app.openTab(g.id) : app.openIn(n.server.id, { session: members[0]!.id }))} ondblclick={() => n.current && sb.startGroupRename(g)} title={t("{name} · 더블 클릭으로 이름 바꾸기", { name: g.name })}>
		<RowTitle text={g.name} />
		{#if folded}<span class="cbadge" title={t("{n}개", { n: members.length })}>{members.length}</span>{/if}
	</button>
</RowShell>
