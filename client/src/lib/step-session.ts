import { tabPanes, type DirBlock } from "./nav";
import { groupKey } from "./sidebar-model";

/** One server as the sidebar lists it. `hidden`: the whole band is unreadable (offline, refused) or not loaded yet. */
export interface StepServer {
	id: string;
	dirs: readonly DirBlock[];
	hidden?: boolean;
	/** Folders inside a folded project: their rows are not on screen, so the step passes them by */
	foldedDirs?: readonly string[];
}

export interface StepTarget {
	server: string;
	id: string;
	/** The step landed on a folder row as a whole (a folded folder, or a workspace step): `id` is its first pane, and the
	 * caller may open the tab last used there instead, as a click on the folder does */
	dir?: string;
}

/**
 * Previous / next row of the sidebar (server band → folder → tab → pane), across servers. A folded folder is one row:
 * stepping onto it opens its first pane, and the walk goes on from there to the next row. An open folder's rows are its
 * tabs (a split tab's panes, only the first while the split tab is folded). Folders with no pane, folders of a folded
 * project and folded or unreadable servers (when several are listed) are passed by; the walk starts from the open row even
 * when it is hidden. It wraps. Returns null when there is no other row to go to.
 */
export function stepRowTarget(
	servers: readonly StepServer[],
	folded: readonly string[],
	dirFolded: (server: string, path: string) => boolean,
	current: { server: string | null; id: string | null },
	step: 1 | -1,
): StepTarget | null {
	const single = servers.length < 2;
	const rows: { server: string; ids: string[]; hidden: boolean; dir?: string }[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		const inFolded = new Set(s.foldedDirs ?? []);
		for (const d of s.dirs) {
			const panes = d.tabs.flatMap((t) => tabPanes(t));
			if (!panes.length) continue;
			const hidden = off || inFolded.has(d.path);
			if (dirFolded(s.id, d.path)) {
				rows.push({ server: s.id, ids: panes, hidden, dir: d.path });
				continue;
			}
			for (const t of d.tabs) {
				const groupFolded = t.kind === "group" && folded.includes(groupKey(t.id));
				tabPanes(t).forEach((id, i) => rows.push({ server: s.id, ids: [id], hidden: hidden || (groupFolded && i > 0) }));
			}
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
		return r.dir === undefined ? { server: r.server, id: r.ids[0]! } : { server: r.server, id: r.ids[0]!, dir: r.dir };
	}
	return null;
}

/**
 * Previous / next workspace (folder block) in sidebar order across servers, landing on the folder's first pane.
 * A folder is one row: a plain folder, or a worktree / folder inside a project. Folders with no pane are skipped, and so
 * are folders of a folded project and folded or unreadable servers when several are listed (with one server the server
 * fold is ignored). Folded folders still count: their row is on screen, and the step opens their first tab. It wraps; with a single folder it goes
 * to that folder's first pane. Returns null when there is nothing to go to.
 */
export function stepWorkspaceTarget(
	servers: readonly StepServer[],
	folded: readonly string[],
	current: { server: string | null; id: string | null },
	step: 1 | -1,
): StepTarget | null {
	const single = servers.length < 2;
	const blocks: { server: string; panes: string[]; hidden: boolean; dir: string }[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		const inFolded = new Set(s.foldedDirs ?? []);
		for (const d of s.dirs) {
			const panes = d.tabs.flatMap((t) => tabPanes(t));
			if (panes.length) blocks.push({ server: s.id, panes, hidden: off || inFolded.has(d.path), dir: d.path });
		}
	}
	if (!blocks.length) return null;
	const id = current.id;
	const at = id ? blocks.findIndex((b) => b.server === current.server && b.panes.includes(id)) : -1;
	for (let k = 1; k <= blocks.length; k++) {
		const i = at < 0 ? (step === 1 ? k - 1 : blocks.length - k) : (((at + step * k) % blocks.length) + blocks.length) % blocks.length;
		const b = blocks[i]!;
		if (b.hidden) continue;
		return { server: b.server, id: b.panes[0]!, dir: b.dir };
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
