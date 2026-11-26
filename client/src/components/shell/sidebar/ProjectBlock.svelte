<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { tail, tailKeepLast, twinParentCandidates } from "../../../lib/fit-text";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { dirPaneCount, tabPanes, type DirBlock as Dir } from "../../../lib/nav";
	import { app } from "../../../lib/store.svelte";
	import { isManualRoot, projectKey } from "../../../lib/projects";
	import { asWorkdir, parentPath } from "../../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import Icon from "../../ui/Icon.svelte";
	import InlineRenameField from "../../ui/InlineRenameField.svelte";
	import DirBlockView from "./DirBlock.svelte";
	import NewButton from "./NewButton.svelte";

	/**
	 * A project: a git repository with more than one folder listed (its main checkout and worktrees under one header, each
	 * named by its branch), or folders the user put together by hand (`manual`, each under its own name). The header folds
	 * the whole project; "+" starts something in the main checkout, or in a hand-made project's first folder. Right click
	 * or a long press opens its menu (rename, undo a hand-made one).
	 */
	let { n, root, dirs }: { n: SidebarNode; root: string; dirs: Dir[] } = $props();

	const sb = getSidebarCtx();
	const key = $derived(projectKey(n.server.id, root));
	const folded = $derived(sb.isFolded(key));
	const manual = $derived(isManualRoot(root));
	const name = $derived(sb.projectName(n, root));
	const above = $derived(manual ? "" : parentPath(root, n.home, name));
	/** Another git project on this server shares the same header name (`shortName`): keep a distinguishing parent visible */
	const peerAboves = $derived.by(() => {
		if (manual) return [];
		const out: string[] = [];
		for (const b of n.blocks) {
			if (b.kind === "project" && !b.manual && b.root !== root && sb.projectName(n, b.root) === name) {
				out.push(parentPath(b.root, n.home, name));
			}
		}
		return out;
	});
	const twin = $derived(peerAboves.length > 0);
	const twinHints = $derived(twin && above ? twinParentCandidates(above, peerAboves) : []);
	/** Where "+" starts: the repository's main checkout, or a hand-made project's first folder */
	const home = $derived(manual ? (dirs[0]?.path ?? n.root ?? ".") : root);
	const workdir = $derived(asWorkdir(home, n.root));
	const total = $derived(dirs.reduce((k, d) => k + dirPaneCount(d), 0));
	const pstate = $derived(mostUrgent(dirs.flatMap((d) => d.tabs.flatMap((x) => tabPanes(x))).map((id) => sb.stateOfId(n, id))));
	/** One of its folders is the open one: the header reads as current, like a folder's */
	const cur = $derived(!app.graphOpen && n.current && dirs.some((d) => d.path === (app.activeTab?.dir.path ?? app.workdirAbs)));
	/** The tab bar lists the whole project (its name was clicked) */
	const shown = $derived(cur && app.tabProject?.serverId === n.server.id && app.tabProject.root === root && app.stripDirs.length > 1);
</script>

<div class="projblock">
	<div class="dir proj grabbable" class:folded class:cur={cur && folded} class:shown use:sb.dirSource={{ kind: "dir", serverId: n.server.id, path: dirs[0]?.path ?? root, paths: [], disabled: true, menu: (pt) => sb.projectMenuAt(pt, n, root, key, workdir) }}>
		<button class="projfold" onclick={() => app.sidebar.toggleFolded(key)} aria-expanded={!folded} aria-label={folded ? t("프로젝트 펼치기") : t("프로젝트 접기")} title={folded ? t("프로젝트 펼치기") : t("프로젝트 접기")}>
			<span class="chev" class:folded><Icon name="chevron-down" /></span>
		</button>
		<button class="dirtoggle projtoggle" onclick={() => (total ? app.openProject(n.server.id, root) : app.sidebar.toggleFolded(key))} aria-current={shown ? "true" : undefined} title={manual ? (total ? t("{name}의 탭 모두 보기", { name }) : name) : total ? `${sb.pretty(n, root)} · ${t("탭 모두 보기")}` : sb.pretty(n, root)}>
			<span class="dicon"><Icon name="repo" /></span>
			<span class="dlabel">
				{#if sb.projectRename.is(key)}
					<InlineRenameField
						variant="heading"
						value={sb.projectRename.draft}
						maxlength={60}
						oninput={(v) => (sb.projectRename.draft = v)}
						oncommit={() => sb.commitProjectRename(n, root)}
						oncancel={() => sb.projectRename.cancel()}
						stopClick
						stopKeys
					/>
				{:else}
					<span class="dname">{name}</span>
					{#if above}
						{#if twin}
							<span class="dparent mono twin" use:tailKeepLast={twinHints}></span>
						{:else}
							<span class="dparent mono" use:tail={above}></span>
						{/if}
					{/if}
				{/if}
			</span>
			{#if folded && total}<span class="cbadge tint {ACTIVITY_TONE[pstate]}" title={t("{n}개", { n: total }) + (pstate !== "idle" ? ` · ${ACTIVITY_LABEL[pstate]}` : "")}>{total}</span>{/if}
		</button>
		<NewButton {n} {workdir} key={key} name={name} tip={t("이 프로젝트에서 새 대화 또는 터미널")} />
	</div>
	{#if !folded}
		<div class="fold projdirs" in:collapseIn out:collapseOut>
			{#each dirs as d (d.path)}
				<DirBlockView {n} {d} inProject={manual ? "manual" : "git"} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.proj {
		display: flex;
		align-items: center;
		margin-top: 4px; /* like a folded folder row; open blocks get 8 around them (DirBlock) */
		margin-right: -8px; /* the highlight runs 8px past the content, like .dir and tab rows */
		padding-right: 8px;
		border-radius: var(--radius-sm);
	}
	.projblock:first-child > .proj {
		margin-top: 4px;
	}
	:global(:where(.side) .projblock:has(> .fold):not(:first-child) > .proj),
	:global(:where(.side) :is(.dirblock, .projblock):has(> .fold) + .projblock > .proj) {
		margin-top: 8px;
	}
	/* the chevron is its own button (it folds the project); the rest of the row lists the whole project in the tab bar.
	   Together they keep the old columns, as in a folder row: chevron x 28, repo icon x 48 */
	.projfold {
		flex: none;
		display: flex;
		align-items: center;
		height: 32px; /* every row is 32px tall */
		padding-left: 4px; /* the chevron's column, as when it sat inside the toggle */
		border-radius: var(--radius-sm);
	}
	.projtoggle {
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
	.proj.grabbable {
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}
	.proj.folded .projtoggle {
		padding-right: 0; /* the count takes the "+" column, as on a folded folder */
	}
	.proj.cur .projtoggle,
	.proj.shown .projtoggle {
		color: var(--text);
	}
	/* the tab bar lists the whole project (or its folded row holds the open tab): its name reads as the open place */
	.proj.cur .dname,
	.proj.shown .dname {
		font-weight: 700;
	}
	@media (hover: hover) {
		.proj:global([data-hovered]) .projtoggle {
			color: var(--text);
		}
	}
	.dicon {
		display: grid;
		flex: none;
		width: 14px;
		color: var(--text-faint);
	}
	.dicon > :global(svg) {
		width: 14px;
		height: 14px;
		stroke-width: 1.9;
	}
	.dlabel {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		line-height: 1;
	}
	.dparent {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		font-size: var(--fs-2xs);
		line-height: 16px; /* whole-pixel line box centred against the 20px project name */
		color: var(--text-faint);
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.dparent.twin {
		min-width: 32px; /* keep twin disambiguation visible even beside a long project name */
		text-overflow: ellipsis;
	}
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
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 500;
		line-height: 20px; /* whole-pixel line box */
	}
	/* a folder's tabs inside a project hang one column further in, under the branch icon (x 68 -> 88) */
	.projdirs :global(.dirblock > .fold) {
		padding-left: 20px; /* the 20px column step */
	}
	@media (pointer: coarse) {
		.projtoggle,
		.projfold {
			height: 40px;
		}
	}
	@media (hover: hover) {
		.proj.folded {
			position: relative;
		}
		:global(:where(.side) .proj.folded .dirnew) {
			position: absolute;
			top: 50%;
			translate: 0 -50%;
			right: 8px; /* the row's right padding: the same centre (x 256) as when unfolded */
		}
		.proj.folded .cbadge {
			transition: opacity var(--motion-fast) var(--ease-std);
		}
		.proj.folded:global([data-hovered]) .cbadge,
		.proj.folded:has(:global(.dirnew.on)) .cbadge {
			opacity: 0;
		}
	}
</style>
