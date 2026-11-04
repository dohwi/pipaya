<script lang="ts">
	import { collapseIn, collapseOut } from "../../lib/motion";
	import { tail } from "../../lib/fit-text";
	import { t } from "../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../lib/activity";
	import { tabPanes } from "../../lib/nav";
	import { app } from "../../lib/store.svelte";
	import { dropTarget } from "../../lib/dnd.svelte";
	import type { DirBlock as Dir } from "../../lib/nav";
	import { asWorkdir, dirKey, archiveKey, parentPath } from "../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../lib/sidebar-ctx";
	import type { Session } from "../../lib/types";
	import type { TerminalInfo } from "../../lib/terminal";
	import Icon from "../Icon.svelte";
	import PinMark from "../PinMark.svelte";
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
	/** This folder's archived conversations: still open, but tucked away. The row is there only when there are some. */
	const archived = $derived(n.archived[d.path] ?? []);
	/** The most urgent state among the folder's tabs: tints the count while folded */
	const dstate = $derived(mostUrgent(d.tabs.flatMap((x) => tabPanes(x)).map((id) => sb.stateOfId(n, id))));
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
			{#if archived.length}
				<div class="archive grp">
					<button class="archtoggle" class:folded={!aopen} onclick={() => app.sidebar.toggleArchive(akey)} aria-expanded={aopen}>
						<span class="chev" class:folded={!aopen}><Icon name="chevron-down" /></span>
						<span class="dicon"><Icon name="archive" /></span>
						<span class="archname">{t("보관함")}</span>
						{#if !aopen}<span class="cbadge" title={t("{n}개", { n: archived.length })}>{archived.length}</span>{/if}
					</button>
					<ListButton serverId={n.server.id} filter={{ cwd: d.path, archived: true }} name={t("보관함 비우기")} tip={t("보관함 관리 (선택해서 닫은 대화로 이동)")} />
					{#if aopen}
						<div class="members fold" in:collapseIn out:collapseOut>
							{#each archived as s (s.id)}
								<ArchivedRow {n} x={s} />
							{/each}
						</div>
					{/if}
				</div>
			{/if}
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
	.archive {
		position: relative;
		margin: 1px 0; /* 1px between rows, like the tab rows */
	}
	/* its own column (x 236) whether the archive is folded or open: folding must not push the list button onto the "+" column */
	.archive :global(.listbtn) {
		position: absolute;
		top: 6px; /* 6 + the 20px button + 6 = the 32px row: its glyph sits on the row's centre line, like the list buttons above */
		right: 20px; /* its centre on x 236, the list-button column of the rows above */
	}
	/* folded on touch there is no hover to bring the button back, and a second glyph on the count's row reads as a broken column:
	   the row shows its count alone, like a folded folder whose list button is hidden too */
	@media (pointer: coarse) {
		.archive:has(> .archtoggle.folded) :global(.listbtn) {
			display: none;
		}
	}
	.archive:hover :global(.listbtn) {
		opacity: 1;
	}
	.archtoggle {
		position: relative;
		display: flex;
		align-items: center;
		gap: 4px;
		width: calc(100% + 4px); /* 4px inset on the left, and the highlight runs 8px past the content on the right like a tab row's (the padding below gives it back) */
		height: 32px; /* every row is 32px tall */
		margin: 0 -8px 0 4px; /* the same inset as a tab row (.item), so its chevron and count line up with the split tab's */
		/* 48 = the 20px list button on x 236 (its right edge 20 from the row end) plus the 8px gap to the count (x 256): the name and its count end where the buttons start */
		padding: 0 48px 0 21px; /* measured: the 14px chevron centres on x 48, the folder icon's column */
		border-radius: var(--radius-sm);
		text-align: left;
		font-size: var(--fs-xs);
		color: var(--text-faint);
	}
	.archtoggle:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	/* the count takes the column of the button that belongs there: x 236 on touch (the list button is hidden while folded, so the
	   count replaces it, as on a folder row), x 256 on a mouse (the list button comes back on x 236 on hover, beside the count).
	   Positioned out of the flow so the 48px the name reserves does not move it */
	.archtoggle :global(.cbadge) {
		position: absolute;
		inset-block: 0;
		margin-block: auto; /* 18px badge centred in the 32px row */
		right: 28px; /* the toggle's end is 8px past the row's: 28 + 8 puts the count's centre on x 236 */
	}
	@media (hover: hover) {
		.archtoggle :global(.cbadge) {
			right: 8px; /* the highlight's extra 8px: the centre stays on x 256 */
		}
	}
	/* the same 16px icon column as a tab's icon (centre x 68), so the archive icon and the tabs' icons share one centre */
	.archtoggle :global(.dicon) {
		width: 16px;
		place-items: center;
	}
	.archname {
		flex: 1;
		min-width: 0;
	}
</style>
