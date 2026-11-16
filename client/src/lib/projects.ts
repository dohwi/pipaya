/**
 * Projects in the sidebar: the folders of one git repository (its main checkout, its worktrees and folders inside them)
 * listed together under one header, each folder labelled by the branch checked out there. Folders outside a repository,
 * and a repository with a single folder open, stay plain folder rows. The server says which repository a folder is in
 * (`POST /fs/repos`, read from `.git` without starting git); a server from before that lists every folder on its own.
 */
import type { DirBlock } from "./nav";
import { SEP } from "./sidebar-model";

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

/** One entry of a server's list: a plain folder, or a project holding two or more folders of one repository. */
export type SidebarBlock = { kind: "dir"; dir: DirBlock } | { kind: "project"; root: string; dirs: DirBlock[] };

/** Fold key of a project header (servers and split tabs have their own; see sidebar-model). */
export const projectKey = (serverId: string, root: string) => `project${SEP}${serverId}${SEP}${root}`;

/**
 * Group `dirs` (already in sidebar order) into projects. A project takes the place of its first folder; inside it the
 * main checkout leads and the others keep their order. A repository with one folder listed is not a project.
 */
export function projectBlocks(dirs: readonly DirBlock[], repos: RepoMap): SidebarBlock[] {
	const byRoot = new Map<string, DirBlock[]>();
	for (const d of dirs) {
		const r = repos[d.path];
		if (r) byRoot.set(r.root, [...(byRoot.get(r.root) ?? []), d]);
	}
	const out: SidebarBlock[] = [];
	const placed = new Set<string>();
	for (const d of dirs) {
		const r = repos[d.path];
		const members = r ? byRoot.get(r.root)! : null;
		if (!r || !members || members.length < 2) {
			out.push({ kind: "dir", dir: d });
			continue;
		}
		if (placed.has(r.root)) continue;
		placed.add(r.root);
		const main = members.filter((m) => m.path === r.root);
		out.push({ kind: "project", root: r.root, dirs: [...main, ...members.filter((m) => m.path !== r.root)] });
	}
	return out;
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
 * How a folder inside a project is labelled: the branch checked out there (the working tree's folder name when HEAD is
 * detached), and the part of the path below that working tree, if any.
 */
export function branchLabel(path: string, repo: RepoInfo): { name: string; sub: string } {
	const top = repo.top.replace(/\\/g, "/").replace(/\/+$/, "");
	const name = repo.branch ?? (top.slice(top.lastIndexOf("/") + 1) || top);
	return { name, sub: subPath(path, repo.top) };
}

/** What the "확인 필요" list shows, most urgent first: a question waiting, a failure, then a finished run not looked at. */
const LOOK_ORDER = ["asking", "failed", "done"] as const;
export type LookState = (typeof LOOK_ORDER)[number];

/**
 * The conversations waiting on the user, in the order they are listed (within one state), skipping terminals. Each
 * appears once even when it is a pane of a split tab.
 */
export function needsLook<S extends { id: string }>(dirs: readonly DirBlock[], stateOf: (id: string) => string, session: (id: string) => S | undefined): { session: S; state: LookState }[] {
	const seen = new Set<string>();
	const out: { session: S; state: LookState; rank: number; at: number }[] = [];
	for (const d of dirs)
		for (const tab of d.tabs)
			for (const id of tab.kind === "group" ? tab.members.map((m) => m.id) : [tab.id]) {
				if (seen.has(id)) continue;
				seen.add(id);
				const state = stateOf(id);
				const rank = LOOK_ORDER.indexOf(state as LookState);
				const s = rank >= 0 ? session(id) : undefined;
				if (s) out.push({ session: s, state: state as LookState, rank, at: out.length });
			}
	return out.sort((a, b) => a.rank - b.rank || a.at - b.at).map(({ session, state }) => ({ session, state }));
}
