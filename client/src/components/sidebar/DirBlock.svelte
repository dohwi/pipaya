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
	import Icon from "../Icon.svelte";
	import GroupBlock from "./GroupBlock.svelte";
	import ListButton from "./ListButton.svelte";
	import NewButton from "./NewButton.svelte";
	import ArchivedRow from "./ArchivedRow.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";

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
			<span class="dicon"><Icon name="folder" /></span>
			<span class="dlabel">
				<span class="dname">{label}</span>
				{#if parent}<span class="dparent mono" use:tail={parent}></span>{/if}
			</span>
			{#if folded}<span class="cbadge" title={t("{n}개", { n: d.tabs.length })}>{d.tabs.length}</span>{/if}
		</button>
		<ListButton serverId={n.server.id} filter={{ cwd: d.path }} name={t("대화 목록 관리")} tip={t("이 디렉터리의 대화 목록 관리")} />
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
					<ListButton serverId={n.server.id} filter={{ cwd: d.path, archived: true }} name={t("보관함 비우기")} tip={t("보관함 관리 (선택해서 닫은 대화로 이동)")} />
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
				{:else}
					<GroupBlock {n} g={tab.group} members={tab.members as (Session | TerminalInfo)[]} {drop} />
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.archive {
		position: relative;
		margin: 1px 0; /* 1px between rows, like the tab rows */
	}
	.archive :global(.listbtn) {
		position: absolute;
		top: 4px;
		right: 20px; /* its centre on x 244, the list-button column of the rows above */
	}
	.archive:hover :global(.listbtn) {
		opacity: 1;
	}
	.archtoggle {
		display: flex;
		align-items: center;
		gap: 4px;
		width: calc(100% - 4px);
		height: 32px; /* every row is 32px tall */
		margin: 0 4px; /* the same inset as a tab row (.item), so its chevron and count line up with the split tab's */
		/* chevron centred under the folder icon above. The count badge ends 8px before the list button, which is 20px wide with
		   its right edge 20 from the row end (button column x 244): 20 + 20 + 8 = 48 */
		padding: 0 48px 0 21px; /* measured: the 14px chevron centres on x 44, the folder icon's column */
		border-radius: var(--radius-sm);
		text-align: left;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.archtoggle:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	/* the same 16px icon column as a tab's icon (centre x 64), so the archive icon and the tabs' icons share one centre */
	.archtoggle :global(.dicon) {
		width: 16px;
		place-items: center;
	}
	.archname {
		flex: 1;
		min-width: 0;
	}
</style>
