/**
 * Projects in the sidebar: the folders of one git repository (its main checkout, its worktrees and folders inside them)
 * listed together under one header, each folder labelled by the branch checked out there. Folders outside a repository,
 * and a repository with a single folder open, stay plain folder rows. The server says which repository a folder is in
 * (`POST /fs/repos`, read from `.git` without starting git); a server from before that lists every folder on its own.
 */
import { tilde } from "./format";
import type { DirBlock } from "./nav";
import { SEP, shortName } from "./sidebar-model";

export interface RepoInfo {
	/** The repository's main working tree: one value for the main checkout and every worktree of it */
	root: string;
	/** The working tree this folder is in (the main checkout or a worktree) */
	top: string;
	/** The checked-out branch; null when HEAD is detached */
	branch: string | null;
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

/**
 * Group `dirs` (already in sidebar order) into projects, in this order of precedence:
 *  1. a project the user made (`over.projects`): its folders, in the order listed there, under its name. Shown even with
 *     one folder listed, since the user asked for it.
 *  2. the git repository of the folder, unless the user took the folder out (`over.ungrouped`); the main checkout leads.
 *     A repository with one folder listed is not a project.
 *  3. otherwise the folder alone.
 * A project takes the place of its first folder.
 */
export function projectBlocks(dirs: readonly DirBlock[], repos: RepoMap, over: ProjectOverrides = {}): SidebarBlock[] {
	const manualOf = new Map<string, ManualProject>();
	for (const p of over.projects ?? []) for (const d of p.dirs) if (!manualOf.has(d)) manualOf.set(d, p);
	const out = new Set(over.ungrouped ?? []);
	const gitRoot = (path: string) => (manualOf.has(path) || out.has(path) ? null : (repos[path]?.root ?? null));
	const byRoot = new Map<string, DirBlock[]>();
	for (const d of dirs) {
		const m = manualOf.get(d.path);
		const root = m ? manualRoot(m.id) : gitRoot(d.path);
		if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), d]);
	}
	const blocks: SidebarBlock[] = [];
	const placed = new Set<string>();
	for (const d of dirs) {
		const m = manualOf.get(d.path);
		const root = m ? manualRoot(m.id) : gitRoot(d.path);
		const members = root ? byRoot.get(root)! : null;
		if (!root || !members || (!m && members.length < 2)) {
			blocks.push({ kind: "dir", dir: d });
			continue;
		}
		if (placed.has(root)) continue;
		placed.add(root);
		if (m) {
			const rank = (p: string) => m.dirs.indexOf(p);
			blocks.push({ kind: "project", root, dirs: [...members].sort((a, b) => rank(a.path) - rank(b.path)), manual: true });
		} else {
			const main = members.filter((x) => x.path === root);
			blocks.push({ kind: "project", root, dirs: [...main, ...members.filter((x) => x.path !== root)] });
		}
	}
	return blocks;
}

/** A hand-made project's id: short, unique enough within one server's list. */
export const newProjectId = (now = Date.now(), rnd = Math.random()) => `${now.toString(36)}${Math.floor(rnd * 1296).toString(36)}`;

/**
 * Put folder `path` into the project `target` (a hand-made one's root, or a repository root when the folder is dropped
 * on a git project it was taken out of), or into a new hand-made project with `with` (another folder). Returns the
 * overrides to keep; `name` names a new project.
 */
export function joinProject(over: ProjectOverrides, path: string, target: { root: string } | { with: string; name: string; id: string }): Required<ProjectOverrides> {
	const projects = (over.projects ?? []).map((p) => ({ ...p, dirs: p.dirs.filter((d) => d !== path) }));
	let ungrouped = [...(over.ungrouped ?? [])];
	if ("root" in target) {
		if (isManualRoot(target.root)) {
			const id = target.root.slice("manual:".length);
			for (const p of projects) if (p.id === id) p.dirs.push(path);
		} else ungrouped = ungrouped.filter((d) => d !== path); // back into its repository's project
	} else {
		const host = projects.find((p) => p.dirs.includes(target.with));
		if (host) host.dirs.push(path);
		else projects.push({ id: target.id, name: target.name, dirs: [target.with, path] });
	}
	return { projects: projects.filter((p) => p.dirs.length), ungrouped };
}

/** Take folder `path` out of whatever project holds it: out of a hand-made one, or marked to stand apart from its repository. */
export function leaveProject(over: ProjectOverrides, path: string, inGitProject: boolean): Required<ProjectOverrides> {
	const projects = (over.projects ?? []).map((p) => ({ ...p, dirs: p.dirs.filter((d) => d !== path) })).filter((p) => p.dirs.length);
	const wasManual = (over.projects ?? []).some((p) => p.dirs.includes(path));
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

export interface TabLead {
	icon: "fork" | "folder";
	label: string;
	title: string;
}

/**
 * The marker before a folder's run of tabs in a project's tab strip.
 * A git project names each folder by its checked-out branch with a fork icon; a hand-made project names each folder by
 * its own label with a folder icon, matching the sidebar's DirBlock.
 */
export function tabLead(
	path: string,
	opts: {
		manual: boolean;
		customName?: string | null;
		repo?: RepoInfo | null;
		home?: string;
	},
): TabLead {
	const fallback = shortName(path, opts.home);
	const custom = opts.customName || null;
	if (opts.manual) {
		const label = custom ?? fallback;
		const full = tilde(path, opts.home);
		return {
			icon: "folder",
			label,
			title: custom && full && custom !== full ? `${custom} · ${full}` : full || label,
		};
	}
	const repo = opts.repo ?? null;
	const br = repo ? branchLabel(path, repo) : null;
	const label = custom ?? (br ? br.name : fallback);
	const title = br?.sub ? `${label} (${br.sub})` : label;
	return {
		icon: repo ? "fork" : "folder",
		label,
		title,
	};
}

