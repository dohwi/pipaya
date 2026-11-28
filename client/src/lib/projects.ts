/**
 * Projects in the sidebar: the folders of one git repository (its main checkout, its worktrees and folders inside them)
 * listed together under one header, each folder labelled by the branch checked out there. Folders outside a repository,
 * and a repository with a single folder open, stay plain folder rows. The server says which repository a folder is in
 * (`POST /fs/repos`, read from `.git` without starting git); a server from before that lists every folder on its own.
 */
import { dirSessions, type DirBlock } from "./nav";
import { tilde } from "./format";
import { SEP, shortName } from "./sidebar-model";

export interface RepoInfo {
	/** The repository's main working tree: one value for the main checkout and every worktree of it */
	root: string;
	/** The working tree this folder is in (the main checkout or a worktree) */
	top: string;
	/** The checked-out branch; null when HEAD is detached */
	branch: string | null;
	/** True for the repository's main checkout (including standalone submodules); false for linked worktrees */
	main?: boolean;
}

/** Folder path -> its repository (null: not in one). A folder not looked up yet is missing. */
export type RepoMap = Readonly<Record<string, RepoInfo | null | undefined>>;

/** One entry of a server's list: a plain folder, or a project holding folders together. */
export type SidebarBlock = { kind: "dir"; dir: DirBlock } | { kind: "project"; root: string; dirs: DirBlock[]; manual?: boolean };

/** A project the user made by hand: a name and the folders in it (absolute paths), kept per server and shared through it. */
export interface ManualProject {
	id: string;
	name: string;
	dirs: string[];
}

/** What the user set on top of the automatic grouping: hand-made projects (they win), and folders taken out of their repository's project. */
export interface ProjectOverrides {
	projects?: readonly ManualProject[];
	ungrouped?: readonly string[];
}

/** The `root` a hand-made project goes by (fold key, rename key): never a path, so it cannot clash with a repository root. */
export const manualRoot = (id: string) => `manual:${id}`;
export const isManualRoot = (root: string) => root.startsWith("manual:");

/** Fold key of a project header (servers and split tabs have their own; see sidebar-model). */
export const projectKey = (serverId: string, root: string) => `project${SEP}${serverId}${SEP}${root}`;

/** Drop duplicate folder paths (within and across projects; first valid project wins) and any hand-made project with fewer than two folders. */
export function cleanManualProjects(projects: readonly ManualProject[]): ManualProject[] {
	const seen = new Set<string>();
	const out: ManualProject[] = [];
	for (const p of projects) {
		const dirs: string[] = [];
		for (const d of p.dirs) {
			if (seen.has(d) || dirs.includes(d)) continue;
			dirs.push(d);
		}
		if (dirs.length < 2) continue;
		for (const d of dirs) seen.add(d);
		out.push({ ...p, dirs });
	}
	return out;
}

/**
 * Fallback while `/fs/repos` has not answered for a newly moved worktree yet: if a session inside `d` moved here via
 * `workdir move` (`activeDir === d.path`), inherit its home folder's hand-made project so the worktree never flashes
 * outside the project before repo metadata arrives.
 */
function homeManualOfDir(
	d: DirBlock,
	manualOf: ReadonlyMap<string, ManualProject>,
	manualByRepoRoot: ReadonlyMap<string, ManualProject>,
	repos: RepoMap,
): { project: ManualProject; anchor: string } | null {
	for (const s of dirSessions(d)) {
		if (typeof s.activeDir !== "string" || s.activeDir !== d.path || typeof s.cwd !== "string" || !s.cwd) continue;
		const direct = manualOf.get(s.cwd);
		if (direct) return { project: direct, anchor: s.cwd };
		const root = repos[s.cwd]?.root;
		if (root) {
			const inherited = manualByRepoRoot.get(root) ?? manualOf.get(root);
			if (inherited) return { project: inherited, anchor: s.cwd };
		}
	}
	return null;
}

/**
 * Group `dirs` (already in sidebar order) into projects, in this order of precedence:
 *  1. a project the user made (`over.projects`, at least two stored folders): its explicit folders plus any other
 *     working tree sharing a git repository with one of its folders (unless explicitly placed elsewhere or in
 *     `over.ungrouped`). A hand-made project keeps its header even when only one of its folders is currently visible.
 *  2. the git repository of the folder, unless the user took the folder out (`over.ungrouped`); the main checkout leads.
 *     A repository with one folder listed is not a project.
 *  3. otherwise the folder alone.
 * A project takes the place of its first folder.
 */
export function projectBlocks(dirs: readonly DirBlock[], repos: RepoMap, over: ProjectOverrides = {}): SidebarBlock[] {
	const cleaned = cleanManualProjects(over.projects ?? []);
	const manualOf = new Map<string, ManualProject>();
	const manualByRepoRoot = new Map<string, ManualProject>();
	for (const p of cleaned) {
		for (const d of p.dirs) {
			if (!manualOf.has(d)) manualOf.set(d, p);
			const repoRoot = repos[d]?.root ?? null;
			if (repoRoot && !manualByRepoRoot.has(repoRoot)) manualByRepoRoot.set(repoRoot, p);
		}
	}
	const out = new Set(over.ungrouped ?? []);
	const resolvedManual = new Map<string, { project: ManualProject; anchor: string | null } | null>();
	const manualFor = (d: DirBlock): { project: ManualProject; anchor: string | null } | null => {
		if (resolvedManual.has(d.path)) return resolvedManual.get(d.path)!;
		const direct = manualOf.get(d.path);
		if (direct) {
			const hit = { project: direct, anchor: d.path };
			resolvedManual.set(d.path, hit);
			return hit;
		}
		if (out.has(d.path)) {
			resolvedManual.set(d.path, null);
			return null;
		}
		const info = repos[d.path];
		if (info) {
			const inherited = manualByRepoRoot.get(info.root) ?? manualOf.get(info.root) ?? null;
			const hit = inherited ? { project: inherited, anchor: null } : null;
			resolvedManual.set(d.path, hit);
			return hit;
		}
		if (info === undefined) {
			const hit = homeManualOfDir(d, manualOf, manualByRepoRoot, repos);
			resolvedManual.set(d.path, hit);
			return hit;
		}
		resolvedManual.set(d.path, null);
		return null;
	};
	const gitRoot = (d: DirBlock) => (manualFor(d) || out.has(d.path) ? null : (repos[d.path]?.root ?? null));
	const byRoot = new Map<string, DirBlock[]>();
	for (const d of dirs) {
		const m = manualFor(d)?.project ?? null;
		const root = m ? manualRoot(m.id) : gitRoot(d);
		if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), d]);
	}
	const blocks: SidebarBlock[] = [];
	const placed = new Set<string>();
	for (const d of dirs) {
		const m = manualFor(d)?.project ?? null;
		const root = m ? manualRoot(m.id) : gitRoot(d);
		const members = root ? byRoot.get(root)! : null;
		if (!root || !members || (!m && members.length < 2)) {
			blocks.push({ kind: "dir", dir: d });
			continue;
		}
		if (placed.has(root)) continue;
		placed.add(root);
		if (m) {
			const sortKey = (x: DirBlock, orig: number): [number, number, number] => {
				const direct = m.dirs.indexOf(x.path);
				if (direct >= 0) return [direct, 0, orig];
				const repoRoot = repos[x.path]?.root ?? null;
				let anchorIdx = repoRoot ? m.dirs.findIndex((p) => p === repoRoot || repos[p]?.root === repoRoot) : -1;
				if (anchorIdx < 0) {
					const homeAnchor = resolvedManual.get(x.path)?.anchor ?? null;
					if (homeAnchor) {
						const homeRoot = repos[homeAnchor]?.root ?? null;
						anchorIdx = m.dirs.findIndex((p) => p === homeAnchor || (homeRoot !== null && (p === homeRoot || repos[p]?.root === homeRoot)));
					}
				}
				return [anchorIdx >= 0 ? anchorIdx : m.dirs.length, 1, orig];
			};
			const keyed = members.map((x, orig) => ({ x, k: sortKey(x, orig) }));
			keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2]);
			blocks.push({ kind: "project", root, dirs: keyed.map((e) => e.x), manual: true });
		} else {
			const isMain = (x: DirBlock) => {
				const r = repos[x.path];
				return r?.main !== undefined ? r.main && x.path === r.top : x.path === root;
			};
			const main = members.filter(isMain);
			blocks.push({ kind: "project", root, dirs: [...main, ...members.filter((x) => !isMain(x))] });
		}
	}
	return blocks;
}

/** A hand-made project's id: short, unique enough within one server's list. */
export const newProjectId = (now = Date.now(), rnd = Math.random()) => `${now.toString(36)}${Math.floor(rnd * 1296).toString(36)}`;

export type JoinTarget =
	| {
			root: string;
			/**
			 * When adding an unrelated folder to a git project, promote its currently visible members into a hand-made
			 * project (subsequent worktrees of its repositories inherit the hand-made project automatically).
			 */
			members?: readonly string[];
			name?: string;
			id?: string;
			/** Repository root of `path`, when known: matching `root` rejoins the git project instead of promoting it. */
			gitRoot?: string | null;
			/** Optional insertion slot inside the project's folder list. */
			at?: { path: string; after: boolean };
			/** Current visible folder order of the target project, so `at` works even on inherited worktrees. */
			visibleOrder?: readonly string[];
	  }
	| {
			with: string;
			name: string;
			id: string;
			at?: { path: string; after: boolean };
	  };

function insertDir(dirs: readonly string[], path: string, at?: { path: string; after: boolean }): string[] {
	const next = dirs.filter((d) => d !== path);
	if (at) {
		const i = next.indexOf(at.path);
		if (i >= 0) {
			next.splice(i + (at.after ? 1 : 0), 0, path);
			return next;
		}
	}
	next.push(path);
	return next;
}

/**
 * Put folder `path` into the project `target` (a hand-made one's root, or a repository root — rejoining if `path` belongs
 * to that repository, or promoting the git project into a hand-made one when `members`/`id`/`name` are supplied), or into
 * a new hand-made project with `with` (another folder). Returns the overrides to keep; `name` names a new project.
 */
export function joinProject(over: ProjectOverrides, path: string, target: JoinTarget): Required<ProjectOverrides> {
	const ungrouped0 = [...(over.ungrouped ?? [])];
	const base = cleanManualProjects(over.projects ?? []);
	if ("with" in target && target.with === path) return { projects: base, ungrouped: ungrouped0 };
	if ("root" in target && isManualRoot(target.root) && !target.at) {
		const id = target.root.slice("manual:".length);
		if (base.some((p) => p.id === id && p.dirs.includes(path))) {
			return { projects: base, ungrouped: ungrouped0.filter((d) => d !== path) };
		}
	}
	const projects = base.map((p) => ({ ...p, dirs: p.dirs.filter((d) => d !== path) }));
	const ungrouped = ungrouped0.filter((d) => d !== path);
	if ("root" in target) {
		if (isManualRoot(target.root)) {
			const id = target.root.slice("manual:".length);
			for (const p of projects) {
				if (p.id !== id) continue;
				const baseDirs = target.at && target.visibleOrder && !p.dirs.includes(target.at.path) && target.visibleOrder.includes(target.at.path)
					? materializeInherited(p.dirs, target.at.path, target.visibleOrder)
					: p.dirs;
				p.dirs = insertDir(baseDirs, path, target.at);
			}
		} else if (target.members?.length && target.id && target.name && target.gitRoot !== target.root) {
			const members = target.members.filter((d, i, a) => d !== path && a.indexOf(d) === i);
			const memberSet = new Set(members);
			for (const p of projects) p.dirs = p.dirs.filter((d) => !memberSet.has(d));
			projects.push({ id: target.id, name: target.name, dirs: insertDir(members, path, target.at) });
		}
	} else {
		const host = projects.find((p) => p.dirs.includes(target.with));
		if (host) host.dirs = insertDir(host.dirs, path, target.at);
		else {
			const dirs = target.at && !target.at.after && target.at.path === target.with ? [path, target.with] : [target.with, path];
			projects.push({ id: target.id, name: target.name, dirs });
		}
	}
	return { projects: cleanManualProjects(projects), ungrouped };
}

/** Insert an inherited folder into `dirs` at the slot matching its current position in `visibleOrder`. */
function materializeInherited(dirs: readonly string[], path: string, visibleOrder: readonly string[]): string[] {
	if (dirs.includes(path)) return [...dirs];
	const visIdx = visibleOrder.indexOf(path);
	const out = [...dirs];
	for (let i = visIdx - 1; i >= 0; i--) {
		const at = out.indexOf(visibleOrder[i]!);
		if (at >= 0) {
			out.splice(at + 1, 0, path);
			return out;
		}
	}
	for (let i = visIdx + 1; i < visibleOrder.length; i++) {
		const at = out.indexOf(visibleOrder[i]!);
		if (at >= 0) {
			out.splice(at, 0, path);
			return out;
		}
	}
	out.push(path);
	return out;
}

/** Reorder `path` before or after `target` within a hand-made project's folder list. Null when nothing changes. */
export function reorderProjectDir(
	over: ProjectOverrides,
	projectId: string,
	path: string,
	target: string,
	after: boolean,
	visibleOrder?: readonly string[],
): Required<ProjectOverrides> | null {
	if (path === target) return null;
	const src = over.projects ?? [];
	const idx = src.findIndex((p) => p.id === projectId);
	if (idx < 0) return null;
	const cur = src[idx]!.dirs;
	const hasBoth = cur.includes(path) && cur.includes(target);
	if (!hasBoth) {
		if (!visibleOrder || !visibleOrder.includes(path) || !visibleOrder.includes(target)) return null;
		const visWithout = visibleOrder.filter((d) => d !== path);
		const visTo = visWithout.indexOf(target) + (after ? 1 : 0);
		if (visTo === visibleOrder.indexOf(path)) return null;
		const baseDirs = materializeInherited(cur, target, visibleOrder);
		const nextDirs = insertDir(baseDirs, path, { path: target, after });
		const projects = src.map((p, i) => (i === idx ? { ...p, dirs: nextDirs } : { ...p, dirs: [...p.dirs] }));
		const ungrouped = (over.ungrouped ?? []).filter((d) => d !== path && d !== target);
		return { projects, ungrouped };
	}
	const nextDirs = insertDir(cur, path, { path: target, after });
	if (nextDirs.length === cur.length && nextDirs.every((d, i) => d === cur[i])) return null;
	const projects = src.map((p, i) => (i === idx ? { ...p, dirs: nextDirs } : { ...p, dirs: [...p.dirs] }));
	return { projects, ungrouped: [...(over.ungrouped ?? [])] };
}

/** Take folder `path` out of whatever project holds it: out of a hand-made one (dissolving it if fewer than two remain), or marked to stand apart from its repository. */
export function leaveProject(over: ProjectOverrides, path: string, inGitProject: boolean): Required<ProjectOverrides> {
	const base = cleanManualProjects(over.projects ?? []);
	const wasManual = base.some((p) => p.dirs.includes(path));
	const projects = cleanManualProjects(base.map((p) => ({ ...p, dirs: p.dirs.filter((d) => d !== path) })));
	const ungrouped = [...(over.ungrouped ?? [])];
	if (!wasManual && inGitProject && !ungrouped.includes(path)) ungrouped.push(path);
	return { projects, ungrouped };
}

/** Undo a hand-made project: its folders go back to the automatic grouping. */
export function dissolveProject(over: ProjectOverrides, id: string): Required<ProjectOverrides> {
	return { projects: (over.projects ?? []).filter((p) => p.id !== id), ungrouped: [...(over.ungrouped ?? [])] };
}

/** The folders in the order the sidebar draws them once grouped: what the tab bar and the shortcuts must walk too. */
export const flattenBlocks = (blocks: readonly SidebarBlock[]): DirBlock[] => blocks.flatMap((b) => (b.kind === "dir" ? [b.dir] : b.dirs));

/** `path` below `top`, with `/` between parts ("" when it is `top` itself, or not under it). */
export function subPath(path: string, top: string): string {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const p = norm(path);
	const t = norm(top);
	return p.startsWith(`${t}/`) ? p.slice(t.length + 1) : "";
}

/**
 * How a folder inside a project is labelled. A working tree's own folder is named by the branch checked out there (the
 * folder's name when HEAD is detached). A folder below it is named by its path inside the working tree, with the branch
 * after it: several folders of one worktree would otherwise all read as the same branch.
 */
export function branchLabel(path: string, repo: RepoInfo): { name: string; sub: string } {
	const top = repo.top.replace(/\\/g, "/").replace(/\/+$/, "");
	const branch = repo.branch ?? (top.slice(top.lastIndexOf("/") + 1) || top);
	const below = subPath(path, repo.top);
	return below ? { name: below, sub: branch } : { name: branch, sub: "" };
}

/** The icon-only marker before a folder's run of tabs; `title` is its hover tooltip. */
export interface TabLead {
	icon: "fork" | "folder";
	title: string;
}

export interface TabLeadOpts {
	manual: boolean;
	customName?: string | null;
	repo?: RepoInfo | null;
	home?: string;
}

/**
 * The marker before a folder's run of tabs in a project's tab strip: a fork icon for a folder of a git project, a folder
 * icon for a hand-made project's folder (always, even when it sits in a repository). Icon only; the name is the tooltip.
 */
export function tabLead(path: string, opts: TabLeadOpts): TabLead {
	const fallback = shortName(path, opts.home);
	const custom = opts.customName || null;
	if (opts.manual) {
		const full = tilde(path, opts.home);
		return { icon: "folder", title: custom && full && custom !== full ? `${custom} · ${full}` : full || fallback };
	}
	const repo = opts.repo ?? null;
	const br = repo ? branchLabel(path, repo) : null;
	const name = custom ?? (br ? br.name : fallback);
	return { icon: repo ? "fork" : "folder", title: br?.sub ? `${name} (${br.sub})` : name };
}

/**
 * Markers for a multi-folder strip, keyed by the id of each folder's first tab. `sep` is false for the first non-empty
 * folder and true for the rest (a hairline sits between runs, never before the first). Empty folders are skipped; one
 * folder or none gives `{}`.
 */
export function tabLeads(
	dirs: readonly DirBlock[],
	leadOf: (d: DirBlock) => TabLead,
): Record<string, TabLead & { sep: boolean }> {
	const out: Record<string, TabLead & { sep: boolean }> = {};
	if (dirs.length <= 1) return out;
	let seen = false;
	for (const d of dirs) {
		const first = d.tabs[0];
		if (!first) continue;
		out[first.id] = { ...leadOf(d), sep: seen };
		seen = true;
	}
	return out;
}

