/**
 * Pure hit-resolution and drop-application rules for dragging folders in the sidebar:
 *  - dragging a folder onto the middle of another folder merges them into a new hand-made project
 *  - dragging a folder onto a project header (or onto a folder inside one) joins that project
 *    (promoting a git project into a hand-made one when an unrelated folder joins it)
 *  - dragging to the top/bottom edge reorders folders (within a project without jumping the project block,
 *    across top-level blocks, inserting into a project at a specific slot, or pulling a folder out of its project)
 */
import type { BlockDrop, BlockPlace } from "./drag-marks.svelte";
import { flattenBlocks, isManualRoot, joinProject, leaveProject, manualRoot, newProjectId, projectBlocks, reorderProjectDir, type ProjectOverrides, type RepoMap, type SidebarBlock } from "./projects";
import { edgeOf } from "./sidebar-model";

export type { BlockDrop, BlockPlace };

export type DirDropHit = { kind: "dir"; path: string } | { kind: "project"; root: string; folded: boolean };

export interface DirResolveOpts {
	blocks: readonly SidebarBlock[];
	repos: RepoMap;
	dragPath: string;
	hit: DirDropHit;
	y: number;
	headerRect: { top: number; bottom: number; height: number };
}

export interface DirDropContext {
	blocks: readonly SidebarBlock[];
	/** Current visible folder paths in `dirOrder` sequence (`n.dirs.map(d => d.path)`). */
	dirOrder: readonly string[];
	repos: RepoMap;
	overrides: ProjectOverrides;
	labelOf: (path: string) => string;
	projectNameOf: (root: string) => string;
	newId?: () => string;
}

export interface DirDropResult {
	overrides?: Required<ProjectOverrides>;
	/** Updated visible folder order to persist via `sidebar.setDirOrder`, when order needs to change. */
	dirOrder?: string[];
	/** Project root to unfold so a newly created / promoted project is immediately visible. */
	revealRoot?: string;
}

type ProjectEntry = Extract<SidebarBlock, { kind: "project" }>;

function reorderList(items: readonly string[], id: string, target: string, after: boolean): string[] | null {
	const from = items.indexOf(id);
	if (from < 0 || id === target || !items.includes(target)) return null;
	const list = items.filter((x) => x !== id);
	const to = list.indexOf(target) + (after ? 1 : 0);
	if (to === from) return null;
	list.splice(to, 0, id);
	return list;
}

/** First member of `paths` as ordered in `dirOrder` — this is the slot where `projectBlocks` anchors the project block. */
function firstInOrder(dirOrder: readonly string[], paths: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestIdx = Infinity;
	for (const p of paths) {
		const idx = dirOrder.indexOf(p);
		if (idx >= 0 && idx < bestIdx) {
			bestIdx = idx;
			best = p;
		}
	}
	return best;
}

/**
 * If `dragPath` sits ahead of `anchor` in `dirOrder`, move it right after `anchor` so joining a project anchored at
 * `anchor` (or merging onto `anchor`) keeps the project block at `anchor`'s position instead of jumping upward.
 */
function anchorOrderAfter(dirOrder: readonly string[], dragPath: string, anchor: string): string[] | undefined {
	const dragIdx = dirOrder.indexOf(dragPath);
	const anchorIdx = dirOrder.indexOf(anchor);
	if (dragIdx < 0 || anchorIdx < 0 || dragIdx >= anchorIdx) return undefined;
	return reorderList(dirOrder, dragPath, anchor, true) ?? undefined;
}

/**
 * Reorder `dragPath` relative to `targetPath` strictly within the slots already occupied by `memberPaths` in `dirOrder`,
 * so reordering inside a git project never shifts the project block past unrelated folders.
 */
function reorderWithinSlots(
	dirOrder: readonly string[],
	memberPaths: readonly string[],
	dragPath: string,
	targetPath: string,
	after: boolean,
): string[] | undefined {
	const memberSet = new Set(memberPaths);
	const slots: number[] = [];
	const inOrder: string[] = [];
	for (let i = 0; i < dirOrder.length; i++) {
		const p = dirOrder[i]!;
		if (memberSet.has(p)) {
			slots.push(i);
			inOrder.push(p);
		}
	}
	const next = reorderList(inOrder, dragPath, targetPath, after);
	if (!next) return undefined;
	const out = [...dirOrder];
	for (let k = 0; k < slots.length; k++) out[slots[k]!] = next[k]!;
	return out;
}

function projectOfPath(blocks: readonly SidebarBlock[], path: string): ProjectEntry | null {
	const found = blocks.find((b) => b.kind === "project" && b.dirs.some((d) => d.path === path));
	return found?.kind === "project" ? found : null;
}

function topBlockIndex(blocks: readonly SidebarBlock[], target: { kind: "dir"; path: string } | { kind: "project"; root: string }): number {
	return blocks.findIndex((b) => (target.kind === "dir" ? b.kind === "dir" && b.dir.path === target.path : b.kind === "project" && b.root === target.root));
}

function isAdjacentInPlace(fromIdx: number, toIdx: number, edge: "before" | "after"): boolean {
	return fromIdx >= 0 && toIdx >= 0 && (edge === "before" ? toIdx === fromIdx + 1 : toIdx === fromIdx - 1);
}

/**
 * Decide which drop action (reorder line or merge highlight) applies when dragging `dragPath` over `hit`.
 * Returns `null` when dropping here would be a no-op (same slot, self, or blocked by git main-checkout pinning).
 */
export function resolveDirDrop(opts: DirResolveOpts): BlockDrop | null {
	const { blocks, repos, dragPath, hit, y, headerRect } = opts;
	const srcProj = projectOfPath(blocks, dragPath);

	if (hit.kind === "dir") {
		if (hit.path === dragPath) return null;
		const dstProj = projectOfPath(blocks, hit.path);
		const sameProj = !!srcProj && !!dstProj && srcProj.root === dstProj.root;

		let place: BlockPlace;
		if (y > headerRect.bottom) {
			// Over an expanded folder's tab list: treat as dropping after the folder block, never merge.
			place = "after";
		} else {
			const canMerge = !sameProj;
			const edge = edgeOf(y, headerRect, !canMerge);
			place = edge ?? "over";
		}

		if (place === "over") {
			return sameProj ? null : { id: `dir:${hit.path}`, place: "over" };
		}

		if (sameProj && dstProj) {
			if (!dstProj.manual) {
				// Git projects pin the main checkout first: moving it or placing anything before it would snap right back.
				if (dragPath === dstProj.root) return null;
				if (hit.path === dstProj.root && place === "before") return null;
			}
			const paths = dstProj.dirs.map((d) => d.path);
			if (isAdjacentInPlace(paths.indexOf(dragPath), paths.indexOf(hit.path), place)) return null;
			return { id: `dir:${hit.path}`, place };
		}

		if (!srcProj && !dstProj) {
			const fromIdx = topBlockIndex(blocks, { kind: "dir", path: dragPath });
			const toIdx = topBlockIndex(blocks, { kind: "dir", path: hit.path });
			if (isAdjacentInPlace(fromIdx, toIdx, place)) return null;
			return { id: `dir:${hit.path}`, place };
		}

		if (dstProj && !dstProj.manual && hit.path === dstProj.root && place === "before") {
			// Rejoining the same repository keeps it a git project where the main checkout stays first.
			if ((repos[dragPath]?.root ?? null) === dstProj.root) return null;
		}

		return { id: `dir:${hit.path}`, place };
	}

	// hit.kind === "project"
	const dstProj = blocks.find((b): b is ProjectEntry => b.kind === "project" && b.root === hit.root) ?? null;
	if (!dstProj) return null;
	const sameProj = srcProj?.root === dstProj.root;

	if (y > headerRect.bottom) return null;

	if (sameProj) {
		// Dragging a project's own folder onto the top half of its header pulls it out right above the project.
		return y < headerRect.top + headerRect.height / 2 ? { id: `project:${hit.root}`, place: "before" } : null;
	}

	const edge = edgeOf(y, headerRect, false);
	if (edge === null) return { id: `project:${hit.root}`, place: "over" };

	if (edge === "after" && !hit.folded) {
		// On an expanded project header, the bottom edge sits right above its first folder — treat it as joining the project
		// rather than drawing a line far away at the bottom of all child folders.
		return { id: `project:${hit.root}`, place: "over" };
	}

	if (!srcProj) {
		const fromIdx = topBlockIndex(blocks, { kind: "dir", path: dragPath });
		const toIdx = topBlockIndex(blocks, { kind: "project", root: hit.root });
		if (isAdjacentInPlace(fromIdx, toIdx, edge)) return null;
	}

	return { id: `project:${hit.root}`, place: edge };
}

/**
 * Pull `dragPath` out of `srcProj` so it stands alone as a top-level folder.
 * If it was in a hand-made project and would immediately snap back into an automatic git project with sibling folders,
 * mark it `ungrouped` too so it actually lands outside.
 */
export function leaveToStandalone(
	over: ProjectOverrides,
	dragPath: string,
	srcProj: ProjectEntry,
	blocks: readonly SidebarBlock[],
	repos: RepoMap,
): Required<ProjectOverrides> {
	const next = leaveProject(over, dragPath, !srcProj.manual);
	if (srcProj.manual && repos[dragPath]?.root) {
		const preview = projectBlocks(flattenBlocks(blocks), repos, next);
		const snappedIntoGit = preview.some((b) => b.kind === "project" && !b.manual && b.dirs.some((d) => d.path === dragPath));
		if (snappedIntoGit && !next.ungrouped.includes(dragPath)) {
			return { projects: next.projects, ungrouped: [...next.ungrouped, dragPath] };
		}
	}
	return next;
}

function joinIntoProject(
	ctx: DirDropContext,
	dragPath: string,
	dstProj: ProjectEntry,
	at?: { path: string; after: boolean },
): { overrides: Required<ProjectOverrides>; revealRoot?: string } {
	if (isManualRoot(dstProj.root)) {
		return { overrides: joinProject(ctx.overrides, dragPath, { root: dstProj.root, at }) };
	}
	const dragGitRoot = ctx.repos[dragPath]?.root ?? null;
	if (dragGitRoot === dstProj.root) {
		return { overrides: joinProject(ctx.overrides, dragPath, { root: dstProj.root, gitRoot: dragGitRoot }) };
	}
	const id = (ctx.newId ?? newProjectId)();
	const overrides = joinProject(ctx.overrides, dragPath, {
		root: dstProj.root,
		members: dstProj.dirs.map((d) => d.path),
		name: ctx.projectNameOf(dstProj.root),
		id,
		gitRoot: dragGitRoot,
		at,
	});
	return { overrides, revealRoot: manualRoot(id) };
}

function orderForProjectJoin(ctx: DirDropContext, dragPath: string, dstProj: ProjectEntry): string[] | undefined {
	const isGitRejoin = !dstProj.manual && (ctx.repos[dragPath]?.root ?? null) === dstProj.root;
	if (isGitRejoin) {
		const tail = dstProj.dirs[dstProj.dirs.length - 1]?.path;
		return tail && tail !== dragPath ? (reorderList(ctx.dirOrder, dragPath, tail, true) ?? undefined) : undefined;
	}
	const anchor = firstInOrder(
		ctx.dirOrder,
		dstProj.dirs.map((d) => d.path),
	);
	return anchor && anchor !== dragPath ? anchorOrderAfter(ctx.dirOrder, dragPath, anchor) : undefined;
}

/**
 * Compute the state mutations for dropping `dragPath` at `drop`.
 * Returns `null` when the drop is invalid or produces no change.
 */
export function applyDirDrop(ctx: DirDropContext, dragPath: string, drop: BlockDrop): DirDropResult | null {
	const srcProj = projectOfPath(ctx.blocks, dragPath);

	if (drop.id.startsWith("project:")) {
		const targetRoot = drop.id.slice("project:".length);
		const dstProj = ctx.blocks.find((b): b is ProjectEntry => b.kind === "project" && b.root === targetRoot) ?? null;
		if (!dstProj) return null;

		if (drop.place === "over") {
			if (srcProj?.root === dstProj.root) return null;
			const { overrides, revealRoot } = joinIntoProject(ctx, dragPath, dstProj);
			const dirOrder = orderForProjectJoin(ctx, dragPath, dstProj);
			return { overrides, dirOrder, revealRoot };
		}

		const after = drop.place === "after";
		const overrides = srcProj ? leaveToStandalone(ctx.overrides, dragPath, srcProj, ctx.blocks, ctx.repos) : undefined;
		const remaining = dstProj.dirs.map((d) => d.path).filter((p) => p !== dragPath);
		const anchor = firstInOrder(ctx.dirOrder, remaining);
		const dirOrder = anchor ? (reorderList(ctx.dirOrder, dragPath, anchor, after) ?? undefined) : undefined;
		if (!overrides && !dirOrder) return null;
		return { overrides, dirOrder };
	}

	if (!drop.id.startsWith("dir:")) return null;
	const targetPath = drop.id.slice("dir:".length);
	if (!targetPath || targetPath === dragPath) return null;

	const dstProj = projectOfPath(ctx.blocks, targetPath);
	const sameProj = !!srcProj && !!dstProj && srcProj.root === dstProj.root;

	if (drop.place === "over") {
		if (sameProj) return null;
		if (dstProj) {
			const { overrides, revealRoot } = joinIntoProject(ctx, dragPath, dstProj);
			const dirOrder = orderForProjectJoin(ctx, dragPath, dstProj);
			return { overrides, dirOrder, revealRoot };
		}
		const id = (ctx.newId ?? newProjectId)();
		const overrides = joinProject(ctx.overrides, dragPath, {
			with: targetPath,
			id,
			name: ctx.labelOf(targetPath),
		});
		const joined = overrides.projects.find((p) => p.dirs.includes(targetPath));
		const dirOrder = anchorOrderAfter(ctx.dirOrder, dragPath, targetPath);
		return {
			overrides,
			dirOrder,
			revealRoot: manualRoot(joined?.id ?? id),
		};
	}

	const after = drop.place === "after";

	if (sameProj && dstProj) {
		if (dstProj.manual) {
			// Manual projects take their internal folder order from `overrides.projects[i].dirs`, so leaving `dirOrder`
			// untouched keeps the project block anchored in place relative to surrounding top-level folders.
			const overrides = reorderProjectDir(ctx.overrides, dstProj.root.slice("manual:".length), dragPath, targetPath, after);
			if (!overrides) return null;
			return { overrides };
		}
		if (dragPath === dstProj.root || (targetPath === dstProj.root && !after)) return null;
		const dirOrder = reorderWithinSlots(
			ctx.dirOrder,
			dstProj.dirs.map((d) => d.path),
			dragPath,
			targetPath,
			after,
		);
		if (!dirOrder) return null;
		return { dirOrder };
	}

	if (dstProj) {
		const isGitRejoin = !dstProj.manual && (ctx.repos[dragPath]?.root ?? null) === dstProj.root;
		if (isGitRejoin && targetPath === dstProj.root && !after) return null;
		const { overrides, revealRoot } = joinIntoProject(ctx, dragPath, dstProj, { path: targetPath, after });
		if (isGitRejoin) {
			const dirOrder = reorderList(ctx.dirOrder, dragPath, targetPath, after) ?? undefined;
			return { overrides, dirOrder, revealRoot };
		}
		const anchor = firstInOrder(
			ctx.dirOrder,
			dstProj.dirs.map((d) => d.path),
		);
		const dirOrder = anchor && anchor !== dragPath ? anchorOrderAfter(ctx.dirOrder, dragPath, anchor) : undefined;
		return { overrides, dirOrder, revealRoot };
	}

	const overrides = srcProj ? leaveToStandalone(ctx.overrides, dragPath, srcProj, ctx.blocks, ctx.repos) : undefined;
	const dirOrder = reorderList(ctx.dirOrder, dragPath, targetPath, after) ?? undefined;
	if (!overrides && !dirOrder) return null;
	return { overrides, dirOrder };
}
