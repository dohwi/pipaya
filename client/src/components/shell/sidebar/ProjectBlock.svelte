<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { tabPanes, type DirBlock as Dir } from "../../../lib/nav";
	import { app } from "../../../lib/store.svelte";
	import { projectKey } from "../../../lib/projects";
	import { asWorkdir, shortName } from "../../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import Icon from "../../ui/Icon.svelte";
	import DirBlockView from "./DirBlock.svelte";
	import NewButton from "./NewButton.svelte";

	/**
	 * A git repository with more than one folder listed: its main checkout and worktrees (and folders inside them) under one
	 * header, each named by its branch. The header folds the whole project; "+" starts something in the main checkout.
	 */
	let { n, root, dirs, searching }: { n: SidebarNode; root: string; dirs: Dir[]; searching: boolean } = $props();

	const sb = getSidebarCtx();
	const key = $derived(projectKey(n.server.id, root));
	const folded = $derived(sb.isFolded(key));
	const name = $derived(app.sidebar.dirName(n.server.id, root) ?? shortName(root, n.home));
	const total = $derived(dirs.reduce((k, d) => k + d.tabs.length, 0));
	const pstate = $derived(mostUrgent(dirs.flatMap((d) => d.tabs.flatMap((x) => tabPanes(x))).map((id) => sb.stateOfId(n, id))));
	/** One of its folders is the open one: the header reads as current, like a folder's */
	const cur = $derived(!app.graphOpen && n.current && dirs.some((d) => d.path === (app.activeTab?.dir.path ?? app.workdirAbs)));
</script>

<div class="projblock">
	<div class="dir proj" class:folded class:cur={cur && folded}>
		<button class="dirtoggle projtoggle" onclick={() => app.sidebar.toggleFolded(key)} aria-expanded={!folded} title={sb.pretty(n, root)}>
			<span class="chev" class:folded><Icon name="chevron-down" /></span>
			<span class="dicon"><Icon name="repo" /></span>
			<span class="dname">{name}</span>
			{#if folded && total}<span class="cbadge tint {ACTIVITY_TONE[pstate]}" title={t("{n}개", { n: total }) + (pstate !== "idle" ? ` · ${ACTIVITY_LABEL[pstate]}` : "")}>{total}</span>{/if}
		</button>
		<NewButton {n} workdir={asWorkdir(root, n.root)} key={key} name={name} tip={t("이 프로젝트에서 새 대화 또는 터미널")} />
	</div>
	{#if !folded}
		<div class="fold projdirs" in:collapseIn out:collapseOut>
			{#each dirs as d (d.path)}
				<DirBlockView {n} {d} {searching} inProject />
			{/each}
		</div>
	{/if}
</div>

<style>
	.proj {
		display: flex;
		align-items: center;
		margin-top: 12px;
		border-radius: var(--radius-sm);
	}
	.projblock:first-child > .proj {
		margin-top: 4px;
	}
	.projtoggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px; /* alignment, not spacing: chevron 14 + 6 = the 20px column step (x 28 -> 48), as in a folder row */
		height: 32px; /* every row is 32px tall */
		border-radius: var(--radius-sm);
		padding: 0 4px;
		text-align: left;
		color: var(--text-dim);
		transition: color var(--motion-fast) var(--ease-std);
	}
	.proj.folded .projtoggle {
		padding-right: 0; /* the count takes the "+" column, as on a folded folder */
	}
	.proj.cur .projtoggle {
		color: var(--text);
	}
	@media (hover: hover) {
		.proj:hover .projtoggle {
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
	.dname {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		font-weight: 600;
		line-height: 20px; /* whole-pixel line box */
	}
	/* a folder's tabs inside a project hang one column further in, under the branch icon (x 68 -> 88) */
	.projdirs :global(.dirblock > .fold) {
		padding-left: 20px; /* the 20px column step */
	}
	@media (pointer: coarse) {
		.projtoggle {
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
			right: 0; /* the same centre (x 256) as when unfolded */
		}
		.proj.folded .cbadge {
			transition: opacity var(--motion-fast) var(--ease-std);
		}
		.proj.folded:hover .cbadge {
			opacity: 0;
		}
	}
</style>
