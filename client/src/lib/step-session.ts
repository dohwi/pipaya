import { tabPanes, type DirBlock } from "./nav";
import { projectKey, type SidebarBlock } from "./projects";
import { groupKey } from "./sidebar-model";

/** One server as the sidebar lists it. `hidden`: the whole band is unreadable (offline, refused) or not loaded yet. */
export interface StepServer {
	id: string;
	dirs: readonly DirBlock[];
	/** Sidebar blocks (standalone folders and grouped projects) in display order. When omitted, `dirs` are standalone folders. */
	blocks?: readonly SidebarBlock[];
	hidden?: boolean;
}

export interface StepTarget {
	server: string;
	id: string;
	/** The step landed on a folder row as a whole (a folded folder, or a workspace step): `id` is its first pane, and the
	 * caller may open the tab last used there instead, as a click on the folder does */
	dir?: string;
	/** The step landed on a folded project row as a whole: `id` is its first pane, and the caller opens the whole project
	 * in the tab bar (`openProject`), as a click on the project header does */
	project?: string;
}

function serverBlocks(s: StepServer): readonly SidebarBlock[] {
	return s.blocks ?? s.dirs.map((dir) => ({ kind: "dir" as const, dir }));
}

function pushDirRows(
	rows: { server: string; ids: string[]; hidden: boolean; dir?: string; project?: string }[],
	server: string,
	d: DirBlock,
	off: boolean,
	folded: readonly string[],
	dirFolded: (server: string, path: string) => boolean,
) {
	const panes = d.tabs.flatMap((t) => tabPanes(t));
	if (!panes.length) return;
	if (dirFolded(server, d.path)) {
		rows.push({ server, ids: panes, hidden: off, dir: d.path });
		return;
	}
	for (const t of d.tabs) {
		const groupFolded = t.kind === "group" && folded.includes(groupKey(t.id));
		tabPanes(t).forEach((id, i) => rows.push({ server, ids: [id], hidden: off || (groupFolded && i > 0) }));
	}
}

/**
 * Previous / next row of the sidebar (server band → project / folder → tab → pane), across servers. A folded project is
 * one row: stepping onto it opens the whole project in the tab bar (`project`), and the walk goes on from there to the
 * next row. A folded folder is one row: stepping onto it opens its last-used/first pane (`dir`). An open project's rows
 * are its folders' rows; an open folder's rows are its tabs (a split tab's panes, only the first while the split tab is
 * folded). Empty folders/projects and folded or unreadable servers (when several are listed) are passed by; the walk
 * starts from the open row even when it is hidden. It wraps. Returns null when there is no other row to go to.
 */
export function stepRowTarget(
	servers: readonly StepServer[],
	folded: readonly string[],
	dirFolded: (server: string, path: string) => boolean,
	current: { server: string | null; id: string | null },
	step: 1 | -1,
): StepTarget | null {
	const single = servers.length < 2;
	const rows: { server: string; ids: string[]; hidden: boolean; dir?: string; project?: string }[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		for (const b of serverBlocks(s)) {
			if (b.kind === "project") {
				if (folded.includes(projectKey(s.id, b.root))) {
					const panes = b.dirs.flatMap((d) => d.tabs.flatMap((t) => tabPanes(t)));
					if (panes.length) rows.push({ server: s.id, ids: panes, hidden: off, project: b.root });
				} else {
					for (const d of b.dirs) pushDirRows(rows, s.id, d, off, folded, dirFolded);
				}
				continue;
			}
			pushDirRows(rows, s.id, b.dir, off, folded, dirFolded);
		}
	}
	if (!rows.length) return null;
	const id = current.id;
	const at = id ? rows.findIndex((r) => r.server === current.server && r.ids.includes(id)) : -1;
	for (let k = 1; k <= rows.length; k++) {
		const i = at < 0 ? (step === 1 ? k - 1 : rows.length - k) : (((at + step * k) % rows.length) + rows.length) % rows.length;
		const r = rows[i]!;
		if (r.hidden) continue;
		if (i === at) return null;
		if (r.project !== undefined) return { server: r.server, id: r.ids[0]!, project: r.project };
		return r.dir === undefined ? { server: r.server, id: r.ids[0]! } : { server: r.server, id: r.ids[0]!, dir: r.dir };
	}
	return null;
}

/**
 * Previous / next workspace (project or folder block) in sidebar order across servers, landing on its first pane.
 * A folded project counts as one row (`project`, opening the whole project in the tab bar); an open project lists each of
 * its worktree / folder rows (`dir`). Empty blocks and folded or unreadable servers (when several are listed) are skipped
 * (with one server the server fold is ignored). Folded folders still count: their row is on screen, and the step opens
 * their first tab. It wraps; with a single block it goes to that block's first pane. Returns null when there is nothing to go to.
 */
export function stepWorkspaceTarget(
	servers: readonly StepServer[],
	folded: readonly string[],
	current: { server: string | null; id: string | null },
	step: 1 | -1,
): StepTarget | null {
	const single = servers.length < 2;
	const blocks: { server: string; panes: string[]; hidden: boolean; dir?: string; project?: string }[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		for (const b of serverBlocks(s)) {
			if (b.kind === "project") {
				if (folded.includes(projectKey(s.id, b.root))) {
					const panes = b.dirs.flatMap((d) => d.tabs.flatMap((t) => tabPanes(t)));
					if (panes.length) blocks.push({ server: s.id, panes, hidden: off, project: b.root });
				} else {
					for (const d of b.dirs) {
						const panes = d.tabs.flatMap((t) => tabPanes(t));
						if (panes.length) blocks.push({ server: s.id, panes, hidden: off, dir: d.path });
					}
				}
				continue;
			}
			const panes = b.dir.tabs.flatMap((t) => tabPanes(t));
			if (panes.length) blocks.push({ server: s.id, panes, hidden: off, dir: b.dir.path });
		}
	}
	if (!blocks.length) return null;
	const id = current.id;
	const at = id ? blocks.findIndex((b) => b.server === current.server && b.panes.includes(id)) : -1;
	for (let k = 1; k <= blocks.length; k++) {
		const i = at < 0 ? (step === 1 ? k - 1 : blocks.length - k) : (((at + step * k) % blocks.length) + blocks.length) % blocks.length;
		const b = blocks[i]!;
		if (b.hidden) continue;
		if (b.project !== undefined) return { server: b.server, id: b.panes[0]!, project: b.project };
		return { server: b.server, id: b.panes[0]!, dir: b.dir! };
	}
	return null;
}

/** What each server says needs the user (its live marks). */
export interface AttentionMarks {
	awaiting: Record<string, number>;
	failed: Record<string, boolean>;
	unread: Record<string, boolean>;
}

/**
 * The conversation that most needs the user, across servers: one asking first, then one that failed, then one that
 * finished unseen. Within a state the search starts right after the open pane in sidebar order and wraps, so pressing
 * again walks every asking conversation in turn instead of bouncing between the first two. Unreachable servers (`hidden`)
 * are passed by: their marks are stale. Folds do not matter: something that needs a look is worth unfolding for.
 */
export function attentionTarget(
	servers: readonly (StepServer & { marks: AttentionMarks })[],
	current: { server: string | null; id: string | null },
): StepTarget | null {
	const list: { server: string; id: string; marks: AttentionMarks }[] = [];
	const seen = new Set<string>();
	for (const s of servers) {
		if (s.hidden) continue;
		for (const d of s.dirs)
			for (const id of d.tabs.flatMap((t) => tabPanes(t))) {
				const k = `${s.id}\u0000${id}`;
				if (seen.has(k)) continue;
				seen.add(k);
				list.push({ server: s.id, id, marks: s.marks });
			}
	}
	const at = current.id ? list.findIndex((e) => e.server === current.server && e.id === current.id) : -1;
	const order = at < 0 ? list : [...list.slice(at + 1), ...list.slice(0, at)];
	const hit =
		order.find((e) => (e.marks.awaiting[e.id] ?? 0) > 0) ??
		order.find((e) => e.marks.failed[e.id]) ??
		order.find((e) => e.marks.unread[e.id]);
	return hit ? { server: hit.server, id: hit.id } : null;
}
