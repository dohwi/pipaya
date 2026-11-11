<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { tail } from "../../../lib/fit-text";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { tabPanes } from "../../../lib/nav";
	import { app } from "../../../lib/store.svelte";
	import { dropTarget } from "../../../lib/dnd.svelte";
	import type { DirBlock as Dir } from "../../../lib/nav";
	import { asWorkdir, dirKey, parentPath } from "../../../lib/sidebar-model";
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
	.dicon :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.dir {
		display: flex;
		align-items: center;
		margin-top: 12px;
		border-radius: var(--radius-sm);
	}
	.dirblock:first-child > .dir {
		margin-top: 4px;
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
	.dirtoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px; /* alignment, not spacing: chevron 14 + 6 = the 20px column step (x 28 -> 48 -> 68) */
		height: 32px; /* every row is 32px tall */
		border-radius: var(--radius-sm);
		padding: 0 4px 0 4px; /* chevron, folder icon, name: its tabs hang under the icon */
		text-align: left;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	/* folded, the list button is hidden, so the toggle runs to the "+" and its count takes the column it gives up: x 256 on a mouse
	   (the "+" is out of the flow there), x 236 on touch (the "+" keeps x 256, so the count lands on the list column) — both measured */
	.dir.folded .dirtoggle {
		padding-right: 0;
	}
	.dir:hover .dirtoggle,
	.dir.cur .dirtoggle {
		color: var(--text);
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
	}
	.dname {
		flex: 0 1 auto; /* the name takes what it needs; only when it alone is too long does it shrink (the parent path, flex 1 from 0, gives way first) */
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
		padding-bottom: 4px;
		margin-bottom: -4px; /* descenders (g p y) overflow the line-height:1 box; widen the clip area without moving layout */
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
	.dirtoggle {
		height: 40px;
	}
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
		right: 0; /* the same centre (x 256) as when unfolded */
	}
	.dir.folded .cbadge {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.dir.folded:hover .cbadge {
		opacity: 0;
	}
	}
</style>
