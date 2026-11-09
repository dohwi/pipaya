<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { tail } from "../../lib/fit-text";
	import { t } from "../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../lib/activity";
	import { tabPanes } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";
	import { dropTarget } from "../../lib/dnd.svelte";
	import type { DirBlock as Dir } from "../../lib/nav";
	import { asWorkdir, dirKey, parentPath } from "../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Session } from "../../lib/types";
	import type { TerminalInfo } from "../../lib/terminal";
	import Icon from "../Icon.svelte";
	import PinMark from "../PinMark.svelte";
	import GroupBlock from "./GroupBlock.svelte";
	import ListButton from "./ListButton.svelte";
	import NewButton from "./NewButton.svelte";
	import RecentTabs from "./RecentTabs.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";

	/**
	 * One folder of a server: its header (fold, name, "+") and its tabs. The header can be dragged to reorder folders,
	 * and a split-tab pane dropped on it steps out of its group.
	 */
	let { n, d, searching }: { n: SidebarNode; d: Dir; searching: boolean } = $props();

	const sb = getSidebarCtx();
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
	const key = $derived(dirKey(n.server.id, d.path));
	const folded = $derived(sb.isFolded(key));
	const mark = $derived(sb.marks.blockMark(`dir:${d.path}`));
	const pinned = $derived(app.sidebar.isPinned(n.server.id, d.path));
	const label = $derived(sb.shortLabel(n, d.path));
	const parent = $derived(sb.pretty(n, d.path));
	/** What shows dim after the name: the path above it, without the part the name already says */
	const above = $derived(parentPath(d.path, n.home, label));
	/** The most urgent state among the folder's tabs: tints the count while folded */
	const dstate = $derived(mostUrgent(d.tabs.flatMap((x) => tabPanes(x)).map((id) => sb.stateOfId(n, id))));
</script>

<!-- A drop and drag target for folders; the folder toggle inside is a real button. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dirblock" data-block={`dir:${d.path}`} data-server={n.server.id} class:carried={mark.carried} class:before={mark.before} class:after={mark.after}>
	<div
		class="dir grabbable"
		class:folded
		class:cur={n.current && d.path === (app.activeTab?.dir.path ?? app.workdirAbs)}
		class:over={sb.marks.over(key)}
		use:dropTarget={{ accepts: (id) => n.current && !!app.groupOf(id), hover: sb.hover(key), drop: sb.dropOnDir }}
		use:sb.dirSource={{ kind: "dir", serverId: n.server.id, path: d.path, paths: n.dirs.map((x) => x.path), disabled: searching || n.dirs.length < 2, menu: (pt) => sb.headMenuAt(pt, n, d.path, key) }}
	>
		<button class="dirtoggle" onclick={() => app.sidebar.toggleFolded(key)} aria-expanded={!folded} title={parent}>
			<span class="chev" class:folded><Icon name="chevron-down" /></span>
			<span class="dicon"><Icon name="folder" />{#if pinned}<PinMark />{/if}</span>
			<span class="dlabel">
				{#if sb.dirRename.is(key)}
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="dnameinput"
						value={sb.dirRename.draft}
						maxlength="60"
						oninput={(e) => (sb.dirRename.draft = e.currentTarget.value)}
						use:focusSelect
						onclick={(e) => e.stopPropagation()}
						onblur={() => sb.commitDirRename(n, d.path)}
						onkeydown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter") sb.commitDirRename(n, d.path);
							if (e.key === "Escape") sb.dirRename.cancel();
						}}
					/>
				{:else}
					<span class="dname" title={label}>{label}</span>
				{/if}
				{#if above}<span class="dparent mono" use:tail={above}></span>{/if}
			</span>
			{#if folded && d.tabs.length}<span class="cbadge tint {ACTIVITY_TONE[dstate]}" title={t("{n}개", { n: d.tabs.length }) + (dstate !== "idle" ? ` · ${ACTIVITY_LABEL[dstate]}` : "")}>{d.tabs.length}</span>{/if}
		</button>
		<ListButton serverId={n.server.id} filter={{ cwd: d.path }} name={t("대화 목록 관리")} tip={t("이 디렉터리의 대화 목록 관리")} />
		<NewButton {n} workdir={asWorkdir(d.path, n.root)} {key} name={parent} tip={t("이 디렉터리에서 새 대화 또는 터미널")} />
	</div>
	{#if !folded}
		<div class="fold" in:collapseIn out:collapseOut>
			{#each d.tabs as tab (tab.id)}
				{@const drop = { accepts: (id: string) => n.current && id !== tab.id, hover: sb.tabHover(n, d, tab), drop: sb.tabDropAt(n, d, tab) }}
				{#if tab.kind === "session"}
					<SessionRow {n} x={tab.session} {drop} />
				{:else if tab.kind === "terminal"}
					<TerminalRow {n} x={tab.terminal} {drop} />
				{:else}
					<GroupBlock {n} g={tab.group} members={tab.members as (Session | TerminalInfo)[]} {drop} />
				{/if}
			{/each}
			<!-- what was closed here in the last hour, under the folder's own tabs (a search lists matches only) -->
			{#if !searching}<RecentTabs {n} path={d.path} />{/if}
		</div>
	{/if}
</div>

<style>
	.dnameinput {
		flex: 1;
		min-width: 0;
		height: 24px;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--accent);
		background: var(--bg);
		outline: 0;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
	}
</style>
