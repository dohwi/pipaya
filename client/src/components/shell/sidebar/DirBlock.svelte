<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { tail, tailKeepLast, twinParentCandidates } from "../../../lib/fit-text";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { dirPaneCount, tabPanes } from "../../../lib/nav";
	import { app } from "../../../lib/store.svelte";
	import { dropTarget } from "../../../lib/dnd.svelte";
	import type { DirBlock as Dir } from "../../../lib/nav";
	import { asWorkdir, dirKey, parentPath } from "../../../lib/sidebar-model";
	import { branchLabel } from "../../../lib/projects";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import type { Session } from "../../../lib/types";
	import type { TerminalInfo } from "../../../lib/terminal";
	import Icon from "../../ui/Icon.svelte";
	import InlineRenameField from "../../ui/InlineRenameField.svelte";
	import PinMark from "../../ui/PinMark.svelte";
	import GroupBlock from "./GroupBlock.svelte";
	import ListButton from "./ListButton.svelte";
	import NewButton from "./NewButton.svelte";
	import SessionRow from "./SessionRow.svelte";
	import TerminalRow from "./TerminalRow.svelte";

	/**
	 * One folder of a server: its header (fold, name, "+") and, once opened, its tabs. Folders start folded: the tab bar
	 * lists the open folder's tabs, so the sidebar is a list of places. Inside a project they start open: the project header
	 * already folds them all. The chevron opens or folds the list; the name shows
	 * the folder (its last used tab). Inside a project the folder is named by its branch. The header can be dragged to
	 * reorder folders, and a split-tab pane dropped on it steps out of its group.
	 */
	/** `inProject`: listed under a project header; "git" names the folder by its branch, "manual" (hand-made) by its own label */
	let { n, d, inProject = false }: { n: SidebarNode; d: Dir; inProject?: false | "git" | "manual" } = $props();

	const sb = getSidebarCtx();
	const key = $derived(dirKey(n.server.id, d.path));
	const folded = $derived(sb.isDirFolded(key, !!inProject));
	/** Inside a project: the folder is named by the branch checked out there (a project lists one repository's worktrees) */
	const repo = $derived(inProject === "git" ? n.repos[d.path] ?? null : null);
	const branch = $derived(repo ? branchLabel(d.path, repo) : null);
	/** The folder whose tabs the tab bar shows */
	/** (while the tab bar lists its whole project, the project's row is the open one instead) */
	const cur = $derived(!app.graphOpen && n.current && d.path === (app.activeTab?.dir.path ?? app.workdirAbs) && !(inProject && app.stripDirs.length > 1));
	const mark = $derived(sb.marks.blockMark(`dir:${d.path}`));
	const pinned = $derived(app.sidebar.isPinned(n.server.id, d.path));
	const label = $derived(sb.shortLabel(n, d.path));
	const parent = $derived(sb.pretty(n, d.path));
	const usesBranch = $derived(Boolean(branch && !app.sidebar.dirName(n.server.id, d.path)));
	/** What shows dim after the name: the path above it, without the part the name already says */
	const above = $derived(parentPath(d.path, n.home, usesBranch ? branch!.name : label));
	/**
	 * Parent paths of other folders that display the exact same label, so twins keep a distinguishing path segment
	 * visible (including inside manual projects and across shared parent suffixes like `/a/sub/app` vs `/b/sub/app`).
	 * Branch-labelled rows only compare within their own git project — different repos sharing a `main` branch are
	 * already distinguished by their project headers.
	 */
	const gitSiblings = $derived.by(() => {
		if (!usesBranch) return [];
		const block = n.blocks.find((b) => b.kind === "project" && !b.manual && b.dirs.some((x) => x.path === d.path));
		return block && block.kind === "project" ? block.dirs : [];
	});
	const peerAboves = $derived.by(() => {
		const out: string[] = [];
		if (usesBranch && branch) {
			if (branch.sub) return out;
			for (const x of gitSiblings) {
				if (x.path === d.path) continue;
				const xRepo = n.repos[x.path] ?? null;
				const xBr = xRepo && !app.sidebar.dirName(n.server.id, x.path) ? branchLabel(x.path, xRepo) : null;
				if (xBr && !xBr.sub && xBr.name === branch.name) out.push(parentPath(x.path, n.home, xBr.name));
			}
			return out;
		}
		for (const b of n.blocks) {
			const list = b.kind === "dir" ? [b.dir] : b.dirs;
			const isGit = b.kind === "project" && !b.manual;
			for (const x of list) {
				if (x.path === d.path) continue;
				const xRepo = isGit ? (n.repos[x.path] ?? null) : null;
				const xBr = xRepo && !app.sidebar.dirName(n.server.id, x.path) ? branchLabel(x.path, xRepo) : null;
				if (!xBr && sb.shortLabel(n, x.path) === label) out.push(parentPath(x.path, n.home, label));
			}
		}
		return out;
	});
	/** Other branch/subpath names inside the same git project, so `tailKeepLast` never collapses sibling subpaths to `…/app`. */
	const peerBranchNames = $derived.by(() => {
		if (!usesBranch || !branch) return [];
		const out: string[] = [];
		for (const x of gitSiblings) {
			if (x.path === d.path) continue;
			const xRepo = n.repos[x.path] ?? null;
			const xBr = xRepo && !app.sidebar.dirName(n.server.id, x.path) ? branchLabel(x.path, xRepo) : null;
			if (xBr && xBr.name !== branch.name) out.push(xBr.name);
		}
		return out;
	});
	const branchNameHints = $derived(
		usesBranch && branch ? twinParentCandidates(branch.name, peerBranchNames, { compact: false }) : [],
	);
	const twin = $derived(peerAboves.length > 0);
	const twinHints = $derived(twin && above ? twinParentCandidates(above, peerAboves) : []);
	/** The most urgent state among the folder's tabs: tints the count while folded */
	const dstate = $derived(mostUrgent(d.tabs.flatMap((x) => tabPanes(x)).map((id) => sb.stateOfId(n, id))));
	const dcount = $derived(dirPaneCount(d));
	/** No tabs inside: keep the chevron's column for alignment, but hide the arrow and never mount an empty fold block */
	const empty = $derived(d.tabs.length === 0);
</script>

<!-- A drop and drag target for folders; the folder toggle inside is a real button. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dirblock" class:inproj={!!inProject} data-block={`dir:${d.path}`} data-server={n.server.id} class:carried={mark.carried} class:before={mark.before} class:after={mark.after}>
	<div
		class="dir grabbable"
		class:folded
		class:empty
		class:cur
		class:over={sb.marks.over(key) || mark.over}
		use:dropTarget={{ accepts: sb.acceptsOnDir(n, d.path), hover: sb.hover(key), drop: sb.dropOnDir(n, d.path) }}
		use:sb.dirSource={{ kind: "dir", serverId: n.server.id, path: d.path, paths: n.dirs.map((x) => x.path), disabled: n.dirs.length < 2, menu: (pt) => sb.headMenuAt(pt, n, d.path, key) }}
	>
		{#if empty}
			<span class="dirfold" aria-hidden="true"><span class="chev hidden"><Icon name="chevron-down" /></span></span>
		{:else}
			<button class="dirfold" onclick={() => app.sidebar.toggleDir(key, !!inProject)} aria-expanded={!folded} aria-label={folded ? t("탭 펼치기") : t("탭 접기")} title={folded ? t("탭 펼치기") : t("탭 접기")}>
				<span class="chev" class:folded><Icon name="chevron-down" /></span>
			</button>
		{/if}
		{#if sb.dirRename.is(key)}
			<div class="dirtoggle">
				<span class="dicon">{#if branch}<Icon name="fork" />{:else}<Icon name="folder" />{/if}{#if pinned}<PinMark />{/if}</span>
				<span class="dlabel">
					<InlineRenameField
						variant="heading"
						value={sb.dirRename.draft}
						maxlength={60}
						oninput={(v) => (sb.dirRename.draft = v)}
						oncommit={() => sb.commitDirRename(n, d.path)}
						oncancel={() => sb.dirRename.cancel()}
						stopClick
						stopKeys
					/>
				</span>
			</div>
		{:else}
			<button class="dirtoggle wide" onclick={() => (d.tabs.length ? app.openDir(n.server.id, d.path) : undefined)} aria-disabled={empty ? "true" : undefined} aria-current={cur ? "true" : undefined} title={parent}>
				<span class="dicon">{#if branch}<Icon name="fork" />{:else}<Icon name="folder" />{/if}{#if pinned}<PinMark />{/if}</span>
				<span class="dlabel">
					{#if usesBranch && branch}
						<!-- a path inside the worktree keeps its distinguishing folder (`…/alpha/app` instead of collapsing twins to `…/app`) -->
						<span class="dname mono" title={branch.name} use:tailKeepLast={branchNameHints}></span>
						{#if branch.sub}
							<span class="dparent mono" use:tail={branch.sub}></span>
						{:else if twin && above}
							<span class="dparent mono twin" use:tailKeepLast={twinHints}></span>
						{/if}
					{:else}
						<span class="dname">{label}</span>
						{#if above && (inProject !== "git" || twin)}
							{#if twin}
								<span class="dparent mono twin" use:tailKeepLast={twinHints}></span>
							{:else}
								<span class="dparent mono" use:tail={above}></span>
							{/if}
						{/if}
					{/if}
				</span>
				{#if folded && dcount}<span class="cbadge tint {ACTIVITY_TONE[dstate]}" title={t("{n}개", { n: dcount }) + (dstate !== "idle" ? ` · ${ACTIVITY_LABEL[dstate]}` : "")}>{dcount}</span>{/if}
			</button>
		{/if}
		<ListButton serverId={n.server.id} filter={{ cwd: d.path }} name={t("삭제된 대화 목록")} tip={t("이 폴더의 삭제된 대화 목록")} />
		<NewButton {n} workdir={asWorkdir(d.path, n.root)} {key} name={parent} tip={t("이 폴더에서 새 대화 또는 터미널")} />
	</div>
	{#if !folded && !empty}
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
	.dicon > :global(svg) { /* the folder glyph only: the pinned mark (PinMark) keeps its own 9px pin */
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.dir {
		display: flex;
		align-items: center;
		margin-top: 4px; /* every folder header stays 4px below the block above so toggling never shifts the clicked row */
		margin-right: -8px; /* like a tab row, the highlight (open, drop) runs 8px past the content and the padding gives it back: the count and "+" keep x 256, 8px inside its edge */
		padding-right: 8px;
		border-radius: var(--radius-sm);
	}
	.dirblock:first-child > .dir {
		margin-top: 4px;
	}
	/* an open folder keeps 8px before the next block (this 4px + the next header's 4px); placing it on .fold lets collapseIn/Out animate it without snapping */
	.dirblock:not(.inproj):not(:last-child) > .fold {
		padding-bottom: 4px;
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
	.dirblock.inproj.before::before,
	.dirblock.inproj.after::after {
		left: 20px; /* aligns with the indented folder row (.dirblock.inproj > .dir margin-left: 20px) */
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
	.chev.hidden {
		visibility: hidden;
	}
	.dir.empty .dirtoggle {
		cursor: default;
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
		.dir:global([data-hovered]) .dirtoggle {
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
		line-height: 16px; /* whole-pixel line box centred against the 20px folder name */
		color: var(--text-faint);
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.dparent.twin {
		min-width: 32px; /* keep twin disambiguation visible even beside a long folder name */
		text-overflow: ellipsis;
	}
	/* the path after the name shows on hover (the tooltip has it too); a folder that shares its name with another keeps it */
	@media (hover: hover) {
		.dparent:not(.twin) {
			opacity: 0;
		}
		.dir:global([data-hovered]) .dparent,
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
		font-weight: 500;
		line-height: 20px; /* a whole-pixel line box centred by the row (rule 3): line-height 1 left a plain name's ink 1.5px below the folder glyph, and clipped its descenders */
	}
	/* a pinned row's mark (PinMark) is set into its icon's corner: the icon boxes are its hosts */
	.dicon {
		position: relative;
	}
	.dir.over {
		outline: 1px solid var(--accent); /* the row has no border: a drop target is outlined inside its box */
		outline-offset: -1px;
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
	.dir.folded:global([data-hovered]) .cbadge,
	.dir.folded:has(:global(.dirnew.on)) .cbadge {
		opacity: 0;
	}
	}
</style>
