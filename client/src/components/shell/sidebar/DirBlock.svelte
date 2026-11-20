<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { tail, tailKeepLast } from "../../../lib/fit-text";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { tabPanes } from "../../../lib/nav";
	import { app } from "../../../lib/store.svelte";
	import { dropTarget } from "../../../lib/dnd.svelte";
	import type { DirBlock as Dir } from "../../../lib/nav";
	import { asWorkdir, dirKey, parentPath } from "../../../lib/sidebar-model";
	import { branchLabel } from "../../../lib/projects";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import type { Session } from "../../../lib/types";
	import type { TerminalInfo } from "../../../lib/terminal";
	import Icon from "../../ui/Icon.svelte";
	import PinMark from "../../ui/PinMark.svelte";
	import GroupBlock from "./GroupBlock.svelte";
	import ListButton from "./ListButton.svelte";
	import NewButton from "./NewButton.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";

	/**
	 * One folder of a server: its header (fold, name, "+") and, once opened, its tabs. Folders start folded, so the sidebar
	 * is a list of places; the folder of what is open lists its tabs on its own until focus moves on (`SidebarState.autoDir`),
	 * and one opened by hand stays open. The chevron opens or folds the list; the name shows
	 * the folder (its last used tab). Inside a project the folder is named by its branch. The header can be dragged to
	 * reorder folders, and a split-tab pane dropped on it steps out of its group.
	 */
	/** `inProject`: listed under a project header; "git" names the folder by its branch, "manual" (hand-made) by its own label */
	let { n, d, inProject = false }: { n: SidebarNode; d: Dir; inProject?: false | "git" | "manual" } = $props();

	const sb = getSidebarCtx();
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
	const key = $derived(dirKey(n.server.id, d.path));
	const folded = $derived(sb.isDirFolded(key));
	/** Inside a project: the folder is named by the branch checked out there (a project lists one repository's worktrees) */
	const repo = $derived(inProject === "git" ? n.repos[d.path] ?? null : null);
	const branch = $derived(repo ? branchLabel(d.path, repo) : null);
	/** The folder whose tabs the tab bar shows */
	const cur = $derived(!app.graphOpen && n.current && d.path === (app.activeTab?.dir.path ?? app.workdirAbs));
	const mark = $derived(sb.marks.blockMark(`dir:${d.path}`));
	/** The pin only marks a folder apart from unpinned ones: when every folder of the server is pinned it says nothing and is left out */
	const pinned = $derived(app.sidebar.isPinned(n.server.id, d.path) && n.dirs.some((x) => !app.sidebar.isPinned(n.server.id, x.path)));
	const label = $derived(sb.shortLabel(n, d.path));
	const parent = $derived(sb.pretty(n, d.path));
	/** What shows dim after the name: the path above it, without the part the name already says */
	const above = $derived(parentPath(d.path, n.home, label));
	/** Another folder of this server has the same name: the path after it stays in view to tell them apart (otherwise it shows on hover) */
	const twin = $derived(n.dirs.some((x) => x.path !== d.path && sb.shortLabel(n, x.path) === label));
	/** The most urgent state among the folder's tabs: tints the count while folded */
	const dstate = $derived(mostUrgent(d.tabs.flatMap((x) => tabPanes(x)).map((id) => sb.stateOfId(n, id))));
</script>

<!-- A drop and drag target for folders; the folder toggle inside is a real button. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dirblock" class:inproj={!!inProject} data-block={`dir:${d.path}`} data-server={n.server.id} class:carried={mark.carried} class:before={mark.before} class:after={mark.after}>
	<div
		class="dir grabbable"
		class:folded
		class:cur
		class:over={sb.marks.over(key)}
		use:dropTarget={{ accepts: sb.acceptsOnDir(n, d.path), hover: sb.hover(key), drop: sb.dropOnDir(n, d.path) }}
		use:sb.dirSource={{ kind: "dir", serverId: n.server.id, path: d.path, paths: n.dirs.map((x) => x.path), disabled: n.dirs.length < 2, menu: (pt) => sb.headMenuAt(pt, n, d.path, key) }}
	>
		<button class="dirfold" onclick={() => app.sidebar.toggleDir(key)} aria-expanded={!folded} aria-label={folded ? t("탭 펼치기") : t("탭 접기")} title={folded ? t("탭 펼치기") : t("탭 접기")}>
			<span class="chev" class:folded><Icon name="chevron-down" /></span>
		</button>
		<button class="dirtoggle" onclick={() => (d.tabs.length ? app.openDir(n.server.id, d.path) : app.sidebar.toggleDir(key))} aria-current={cur ? "true" : undefined} title={parent}>
			<span class="dicon">{#if branch}<Icon name="fork" />{:else}<Icon name="folder" />{/if}{#if pinned}<PinMark />{/if}</span>
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
				{:else if branch && !app.sidebar.dirName(n.server.id, d.path)}
					<!-- a path inside the worktree keeps its last folder (`…/alpha`): the end is what tells sibling folders apart -->
					<span class="dname mono" title={branch.name} use:tailKeepLast={branch.name}></span>
					{#if branch.sub}<span class="dparent mono" use:tail={branch.sub}></span>{/if}
				{:else}
					<span class="dname" title={label}>{label}</span>
					{#if above && !inProject}<span class="dparent mono" class:twin use:tail={above}></span>{/if}
				{/if}
			</span>
			{#if folded && d.tabs.length}<span class="cbadge tint {ACTIVITY_TONE[dstate]}" title={t("{n}개", { n: d.tabs.length }) + (dstate !== "idle" ? ` · ${ACTIVITY_LABEL[dstate]}` : "")}>{d.tabs.length}</span>{/if}
		</button>
		<ListButton serverId={n.server.id} filter={{ cwd: d.path }} name={t("대화 목록 관리")} tip={t("이 폴더의 대화 목록 관리")} />
		<NewButton {n} workdir={asWorkdir(d.path, n.root)} {key} name={parent} tip={t("이 폴더에서 새 대화 또는 터미널")} />
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
	.dicon > :global(svg) { /* the folder glyph only: the pinned mark (PinMark) keeps its own 9px pin */
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.dir {
		display: flex;
		align-items: center;
		margin-top: 4px; /* folded folders sit 4 apart; an open folder's tab list gets 8 around it (below) */
		margin-right: -8px; /* like a tab row, the highlight (open, drop) runs 8px past the content and the padding gives it back: the count and "+" keep x 256, 8px inside its edge */
		padding-right: 8px;
		border-radius: var(--radius-sm);
	}
	.dirblock:first-child > .dir {
		margin-top: 4px;
	}
	/* an open folder stands 8 off the folder above, and the next one 8 off its tabs */
	:global(:where(.side) .dirblock:not(.inproj):has(> .fold):not(:first-child) > .dir),
	:global(:where(.side) :is(.dirblock, .projblock):has(> .fold) + .dirblock:not(.inproj) > .dir) {
		margin-top: 8px;
	}
	.dir.grabbable {
		cursor: grab;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}
	.dirblock {
		position: relative;
	}
	.dirblock.before::before,
	.dirblock.after::after {
		left: 0;
		right: 0;
	}
	.dirblock.before::before {
		top: -1px;
	}
	.dirblock.after::after {
		bottom: -1px;
	}
	/* the chevron is its own button (it opens the tab list); the rest of the row shows the folder. Together they keep the old
	   columns: chevron x 28, folder icon x 48 */
	.dirfold {
		flex: none;
		display: flex;
		align-items: center;
		height: 32px; /* every row is 32px tall */
		padding-left: 4px; /* the chevron's column, as when it sat inside the toggle */
		border-radius: var(--radius-sm);
	}
	.dirtoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px; /* alignment, not spacing: the icon 14 + 6 puts the name where it was */
		height: 32px; /* every row is 32px tall */
		border-radius: var(--radius-sm);
		padding: 0 4px 0 6px; /* alignment: the gap the chevron used to keep to the icon (14 + 6 = the 20px column step, x 28 -> 48) */
		text-align: left;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	/* the open folder while its tabs are folded: the selection marker sits on it (see Sidebar OPEN_ROW) */
	.dir.cur .dname {
		font-weight: 700;
	}
	/* folded, the list button is hidden, so the toggle runs to the "+" and its count takes the column it gives up: x 256 on a mouse
	   (the "+" is out of the flow there), x 236 on touch (the "+" keeps x 256, so the count lands on the list column) — both measured */
	.dir.folded .dirtoggle {
		padding-right: 0;
	}
	.dir.cur .dirtoggle {
		color: var(--text);
	}
	@media (hover: hover) {
		.dir:hover .dirtoggle {
			color: var(--text);
		}
	}
	.dicon {
		display: grid;
		flex: none;
		width: 14px;
		color: var(--text-faint);
	}
	/* name and parent path are centred on the same horizontal line, which is the icons' centre (line-height 1 drops the uneven leading) */
	.dlabel {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		line-height: 1;
	}
	/* where the folder sits, dim after its name; the full path is the tooltip */
	.dparent {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap; /* no ellipsis: `tail` cuts at folder boundaries or hides the path, never mid-name */
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	/* the path after the name shows on hover (the tooltip has it too); a folder that shares its name with another keeps it */
	@media (hover: hover) {
		.dparent:not(.twin) {
			opacity: 0;
		}
		.dir:hover .dparent,
		.dir:has(:focus-visible) .dparent {
			opacity: 1;
		}
	}
	.dname {
		flex: 0 1 auto; /* the name takes what it needs; only when it alone is too long does it shrink (the parent path, flex 1 from 0, gives way first) */
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px; /* a whole-pixel line box centred by the row (rule 3): line-height 1 left a plain name's ink 1.5px below the folder glyph, and clipped its descenders */
	}
	/* a pinned row's mark (PinMark) is set into its icon's corner: the icon boxes are its hosts */
	.dicon {
		position: relative;
	}
	.dir.over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	/* a block being dragged fades */
	.dirblock.carried {
		opacity: 0.45;
	}
	@media (pointer: coarse) {
	.dirtoggle,
	.dirfold {
		height: 40px;
	}
	}
	/* a folder inside a project: one step in, under the project's icon (x 48 -> chevron, x 68 -> branch icon) */
	.dirblock.inproj > .dir {
		margin-top: 0;
		margin-left: 20px; /* the 20px column step; a margin, so the highlight starts at the folder's own column, not the project's */
	}
	.dirblock.inproj:first-child > .dir {
		margin-top: 1px; /* rows sit 1px apart, like .item */
	}
	.dirblock.inproj .dname.mono {
		font-size: var(--fs-xs);
		font-weight: 500;
	}
	.dirblock.inproj .dir.cur .dname.mono {
		font-weight: 700;
	}
	@media (hover: hover) {
	.dir.folded {
		position: relative;
	}
	:global(:where(.side) .dir.folded .dirnew) {
		position: absolute;
		top: 50%;
		translate: 0 -50%;
	}
	:global(:where(.side) .dir.folded .dirnew) {
		right: 8px; /* the row's right padding: the same centre (x 256) as when unfolded */
	}
	.dir.folded .cbadge {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.dir.folded:hover .cbadge {
		opacity: 0;
	}
	}
</style>
