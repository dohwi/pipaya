<script lang="ts">
	import { collapseIn, collapseOut } from "../../../lib/motion";
	import { t } from "../../../lib/i18n";
	import { ACTIVITY_LABEL, ACTIVITY_TONE, mostUrgent } from "../../../lib/activity";
	import { tabPanes, type DirBlock as Dir } from "../../../lib/nav";
	import { app } from "../../../lib/store.svelte";
	import { isManualRoot, projectKey } from "../../../lib/projects";
	import { asWorkdir } from "../../../lib/sidebar-model";
	import { getSidebarCtx, type SidebarNode } from "../../../lib/sidebar-ctx";
	import Icon from "../../ui/Icon.svelte";
	import DirBlockView from "./DirBlock.svelte";
	import NewButton from "./NewButton.svelte";

	/**
	 * A project: a git repository with more than one folder listed (its main checkout and worktrees under one header, each
	 * named by its branch), or folders the user put together by hand (`manual`, each under its own name). The header folds
	 * the whole project; "+" starts something in the main checkout, or in a hand-made project's first folder. Right click
	 * or a long press opens its menu (rename, undo a hand-made one).
	 */
	let { n, root, dirs }: { n: SidebarNode; root: string; dirs: Dir[] } = $props();
	function focusSelect(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	const sb = getSidebarCtx();
	const key = $derived(projectKey(n.server.id, root));
	const folded = $derived(sb.isFolded(key));
	const manual = $derived(isManualRoot(root));
	const name = $derived(sb.projectName(n, root));
	/** Where "+" starts: the repository's main checkout, or a hand-made project's first folder */
	const home = $derived(manual ? (dirs[0]?.path ?? n.root ?? ".") : root);
	const workdir = $derived(asWorkdir(home, n.root));
	const total = $derived(dirs.reduce((k, d) => k + d.tabs.length, 0));
	const pstate = $derived(mostUrgent(dirs.flatMap((d) => d.tabs.flatMap((x) => tabPanes(x))).map((id) => sb.stateOfId(n, id))));
	/** One of its folders is the open one: the header reads as current, like a folder's */
	const cur = $derived(!app.graphOpen && n.current && dirs.some((d) => d.path === (app.activeTab?.dir.path ?? app.workdirAbs)));
</script>

<div class="projblock">
	<div class="dir proj grabbable" class:folded class:cur={cur && folded} use:sb.dirSource={{ kind: "dir", serverId: n.server.id, path: dirs[0]?.path ?? root, paths: [], disabled: true, menu: (pt) => sb.projectMenuAt(pt, n, root, key, workdir) }}>
		<button class="dirtoggle projtoggle" onclick={() => app.sidebar.toggleFolded(key)} aria-expanded={!folded} title={manual ? name : sb.pretty(n, root)}>
			<span class="chev" class:folded><Icon name="chevron-down" /></span>
			<span class="dicon"><Icon name="repo" /></span>
			{#if sb.projectRename.is(key)}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="pnameinput"
					value={sb.projectRename.draft}
					maxlength="60"
					oninput={(e) => (sb.projectRename.draft = e.currentTarget.value)}
					use:focusSelect
					onclick={(e) => e.stopPropagation()}
					onblur={() => sb.commitProjectRename(n, root)}
					onkeydown={(e) => {
						e.stopPropagation();
						if (e.key === "Enter") sb.commitProjectRename(n, root);
						if (e.key === "Escape") sb.projectRename.cancel();
					}}
				/>
			{:else}
				<span class="dname">{name}</span>
			{/if}
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
	.pnameinput {
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
	.proj.grabbable {
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
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
			right: 8px; /* the row's right padding: the same centre (x 256) as when unfolded */
		}
		.proj.folded .cbadge {
			transition: opacity var(--motion-fast) var(--ease-std);
		}
		.proj.folded:hover .cbadge {
			opacity: 0;
		}
	}
</style>
