<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { tail } from "../../lib/fit-text";
	import { t } from "../../lib/i18n";
	import { app } from "../../lib/store.svelte";
	import { dropTarget } from "../../lib/dnd.svelte";
	import type { DirBlock as Dir } from "../../lib/nav";
	import { asWorkdir, dirKey, archiveKey } from "../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Session } from "../../lib/types";
	import type { TerminalInfo } from "../../lib/terminal";
	import type { BrowserTabInfo } from "../../lib/browser";
	import Icon from "../Icon.svelte";
	import GroupBlock from "./GroupBlock.svelte";
	import NewButton from "./NewButton.svelte";
	import ArchivedRow from "./ArchivedRow.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";
	import BrowserRow from "./BrowserRow.svelte";

	/**
	 * One folder of a server: its header (fold, name, "+") and its tabs. The header can be dragged to reorder folders,
	 * and a split-tab pane dropped on it steps out of its group.
	 */
	let { n, d, searching }: { n: SidebarNode; d: Dir; searching: boolean } = $props();

	const sb = getSidebarCtx();
	const key = $derived(dirKey(n.server.id, d.path));
	const folded = $derived(sb.isFolded(key));
	const mark = $derived(sb.marks.blockMark(`dir:${d.path}`));
	const label = $derived(sb.shortLabel(n, d.path));
	const parent = $derived(sb.pretty(n, d.path));
	/** This folder's archived conversations: still open, but tucked away. The row is there only when there are some. */
	const archived = $derived(n.archived[d.path] ?? []);
	const akey = $derived(archiveKey(n.server.id, d.path));
	/** Archives start folded; a search opens them so its matches show. */
	const aopen = $derived(sb.searching || app.sidebar.archiveOpen.includes(akey));
</script>

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
			<span class="dicon"><Icon name="folder" /></span>
			<span class="dlabel">
				<span class="dname">{label}</span>
				{#if parent}<span class="dparent mono" use:tail={parent}></span>{/if}
			</span>
			{#if folded}<span class="cbadge" title={t("{n}개", { n: d.tabs.length })}>{d.tabs.length}</span>{/if}
		</button>
		<NewButton {n} workdir={asWorkdir(d.path, n.root)} {key} name={parent} tip={t("이 디렉터리에서 새 대화 또는 터미널")} />
	</div>
	{#if !folded}
		<div class="fold" in:collapseIn out:collapseOut>
			{#if archived.length}
				<div class="archive">
					<button class="archtoggle" onclick={() => app.sidebar.toggleArchive(akey)} aria-expanded={aopen}>
						<span class="chev" class:folded={!aopen}><Icon name="chevron-down" /></span>
						<span class="dicon"><Icon name="archive" /></span>
						<span class="archname">{t("보관함")}</span>
						{#if !aopen}<span class="cbadge" title={t("{n}개", { n: archived.length })}>{archived.length}</span>{/if}
					</button>
					{#if aopen}
						<div class="fold" in:collapseIn out:collapseOut>
							{#each archived as s (s.id)}
								<ArchivedRow {n} x={s} />
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			{#each d.tabs as tab (tab.id)}
				{@const drop = { accepts: (id: string) => n.current && id !== tab.id, hover: sb.tabHover(d, tab), drop: sb.tabDropAt(n, d, tab) }}
				{#if tab.kind === "session"}
					<SessionRow {n} x={tab.session} {drop} />
				{:else if tab.kind === "terminal"}
					<TerminalRow {n} x={tab.terminal} {drop} />
				{:else if tab.kind === "browser"}
					<BrowserRow {n} x={tab.browser} {drop} />
				{:else}
					<GroupBlock {n} g={tab.group} members={tab.members as (Session | TerminalInfo | BrowserTabInfo)[]} {drop} />
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.archive {
		margin-bottom: 2px;
	}
	.archtoggle {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		height: 28px;
		padding: 0 10px 0 23px;
		border-radius: var(--radius-sm);
		text-align: left;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.archtoggle:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	.archname {
		flex: 1;
		min-width: 0;
	}
</style>
