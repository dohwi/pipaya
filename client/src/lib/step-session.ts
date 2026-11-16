import { tabPanes, type DirBlock } from "./nav";

/** One server as the sidebar lists it. `hidden`: the whole band is unreadable (offline, refused) or not loaded yet. */
export interface StepServer {
	id: string;
	dirs: readonly DirBlock[];
	hidden?: boolean;
}

export interface StepTarget {
	server: string;
	id: string;
}

/**
 * Previous / next workspace (folder block) in sidebar order across servers, landing on the folder's first pane.
 * Folders with no pane are skipped, and so are folded or unreadable servers when several are listed (with one server
 * the server fold is ignored). Folded folders still count: the step opens them. It wraps; with a single folder it goes
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
		for (const d of s.dirs) {
			const panes = d.tabs.flatMap((t) => tabPanes(t));
			if (panes.length) blocks.push({ server: s.id, panes, hidden: off });
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
