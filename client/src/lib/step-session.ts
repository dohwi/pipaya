import { tabPanes, type DirBlock } from "./nav";
import { dirKey, groupKey } from "./sidebar-model";

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
 * Previous / next conversation in the order the sidebar shows (server band → folder → tab → pane), across servers.
 * Rows hidden by a folded server, folder or split group are skipped, but the walk starts from the open row even when
 * it is hidden. It wraps from the last row to the first. With one server the server fold is ignored, so this is the
 * same walk as before servers were joined. Returns null when there is no other row to go to.
 */
export function stepSessionTarget(
	servers: readonly StepServer[],
	folded: readonly string[],
	current: { server: string | null; id: string | null },
	step: 1 | -1,
): StepTarget | null {
	const single = servers.length < 2;
	const order: (StepTarget & { hidden: boolean })[] = [];
	for (const s of servers) {
		const off = !single && (s.hidden === true || folded.includes(s.id));
		for (const d of s.dirs) {
			const dirFolded = folded.includes(dirKey(s.id, d.path));
			for (const t of d.tabs) {
				const groupFolded = t.kind === "group" && folded.includes(groupKey(t.id));
				tabPanes(t).forEach((id, i) => order.push({ server: s.id, id, hidden: off || dirFolded || (groupFolded && i > 0) }));
			}
		}
	}
	if (!order.length) return null;
	const at = current.id ? order.findIndex((r) => r.server === current.server && r.id === current.id) : -1;
	for (let k = 1; k <= order.length; k++) {
		const i = at < 0 ? (step === 1 ? k - 1 : order.length - k) : (((at + step * k) % order.length) + order.length) % order.length;
		const row = order[i]!;
		if (row.hidden) continue;
		if (row.server === current.server && row.id === current.id) return null;
		return { server: row.server, id: row.id };
	}
	return null;
}
