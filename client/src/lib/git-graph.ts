import type { GitCommit } from "./types";

/** A line of one graph row, in lane units: x is a lane index, y runs 0 (row top) · 0.5 (the dot) · 1 (row bottom). */
export interface GraphSeg {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** Index into the palette. */
	color: number;
}

export interface GraphRow {
	commit: GitCommit;
	/** The lane the dot sits on. */
	col: number;
	color: number;
	segs: GraphSeg[];
}

export interface Graph {
	rows: GraphRow[];
	/** Lanes the widest row needs, so every row's drawing is the same width and the lines meet. */
	lanes: number;
}

interface Lane {
	hash: string;
	color: number;
}

/**
 * Lane layout for a topologically ordered log (children before parents), the way `git log --graph` does it: each lane
 * waits for one commit; a commit takes the lane(s) waiting for it, hands its first parent the same lane and any other
 * parent a lane of its own (the fork-in line of a merge).
 */
export function layoutGraph(commits: GitCommit[], palette: number): Graph {
	const lanes: (Lane | null)[] = [];
	const rows: GraphRow[] = [];
	let next = 0;
	let width = 1;
	const fresh = () => next++ % palette;
	const free = (not: number) => {
		const i = lanes.findIndex((l, k) => l === null && k !== not);
		return i < 0 ? lanes.length : i;
	};

	for (const commit of commits) {
		const waiting = lanes.flatMap((l, i) => (l?.hash === commit.hash ? [i] : []));
		const col = waiting[0] ?? free(-1);
		const color = waiting.length ? lanes[col]!.color : fresh();
		const segs: GraphSeg[] = [];

		lanes.forEach((l, i) => {
			if (!l) return;
			if (l.hash === commit.hash) segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: l.color });
			else segs.push({ x1: i, y1: 0, x2: i, y2: 1, color: l.color });
		});
		for (const i of waiting) lanes[i] = null;

		const [first, ...others] = commit.parents;
		if (first) {
			const at = lanes.findIndex((l) => l?.hash === first);
			if (at >= 0 && at !== col) {
				// the first parent already has a lane (a sibling got there first): join it instead of starting a duplicate
				segs.push({ x1: col, y1: 0.5, x2: at, y2: 1, color: lanes[at]!.color });
			} else {
				lanes[col] = { hash: first, color };
				segs.push({ x1: col, y1: 0.5, x2: col, y2: 1, color });
			}
		}
		for (const p of others) {
			let at = lanes.findIndex((l) => l?.hash === p);
			if (at < 0) {
				at = free(col);
				lanes[at] = { hash: p, color: fresh() };
			}
			segs.push({ x1: col, y1: 0.5, x2: at, y2: 1, color: lanes[at]!.color });
		}
		while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
		width = Math.max(width, lanes.length, col + 1, ...segs.map((s) => Math.max(s.x1, s.x2) + 1));
		rows.push({ commit, col, color, segs });
	}
	return { rows, lanes: width };
}
