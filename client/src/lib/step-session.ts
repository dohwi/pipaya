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
	const rows: { server: string; ids: string[]; hidden: boolean }[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		const inFolded = new Set(s.foldedDirs ?? []);
		for (const d of s.dirs) {
			const panes = d.tabs.flatMap((t) => tabPanes(t));
			if (!panes.length) continue;
			const hidden = off || inFolded.has(d.path);
			if (dirFolded(s.id, d.path)) {
				rows.push({ server: s.id, ids: panes, hidden });
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
		return { server: r.server, id: r.ids[0]! };
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
	const blocks: { server: string; panes: string[]; hidden: boolean }[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		const inFolded = new Set(s.foldedDirs ?? []);
		for (const d of s.dirs) {
			const panes = d.tabs.flatMap((t) => tabPanes(t));
			if (panes.length) blocks.push({ server: s.id, panes, hidden: off || inFolded.has(d.path) });
		}
	}
	if (!blocks.length) return null;
	const id = current.id;
	const at = id ? blocks.findIndex((b) => b.server === current.server && b.panes.includes(id)) : -1;
	for (let k = 1; k <= blocks.length; k++) {
		const i = at < 0 ? (step === 1 ? k - 1 : blocks.length - k) : (((at + step * k) % blocks.length) + blocks.length) % blocks.length;
		const b = blocks[i]!;
		if (b.hidden) continue;
		return { server: b.server, id: b.panes[0]! };
	}
	return null;
}
