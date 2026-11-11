import type { WorkspaceInfo } from "./types";

export interface RecentDir {
	path: string;
	label: string;
	title: string;
	current: boolean;
}

/** Folders with the freshest conversations first, at most `max`; the current one is always kept so the row shows where a new chat lands. */
export function recentDirs(info: WorkspaceInfo | null | undefined, current: string, max = 3): RecentDir[] {
	const rows = [...(info?.workdirs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
	const pick = rows.slice(0, max);
	const here = rows.find((w) => w.path === current);
	if (here && !pick.includes(here)) pick[pick.length - 1] = here;
	return pick.map((w) => ({
		path: w.path,
		label: w.path === "." ? "~" : (w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.path),
		title: w.cwd,
		current: w.path === current,
	}));
}
