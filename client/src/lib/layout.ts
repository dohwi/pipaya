/**
 * Split-window layout of a session group: a binary tree.
 * A `pane` shows one session; a `split` divides its area in two ("row": a | b side by side, "col": a over b).
 * Mirrors the server's validation, which stays the authority (it clamps ratios and enforces one group per session).
 */
export type Layout =
	| { type: "pane"; sessionId: string }
	| { type: "split"; dir: "row" | "col"; ratio: number; a: Layout; b: Layout };

export type Edge = "left" | "right" | "top" | "bottom";
/** Where a drop lands on a pane: the edge it is nearest to. A pane is only ever split, never replaced, so there is no middle. */
export type Zone = Edge;
/** Route from the root to a node: "a" = first child, "b" = second. */
export type Path = ("a" | "b")[];

export const MAX_PANES = 8;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

export const pane = (sessionId: string): Layout => ({ type: "pane", sessionId });

export function panesOf(l: Layout): string[] {
	return l.type === "pane" ? [l.sessionId] : [...panesOf(l.a), ...panesOf(l.b)];
}

export const has = (l: Layout, id: string) => panesOf(l).includes(id);

/** Remove a session's pane; its sibling takes the space. null = nothing left. */
export function remove(l: Layout, id: string): Layout | null {
	if (l.type === "pane") return l.sessionId === id ? null : l;
	const a = remove(l.a, id);
	const b = remove(l.b, id);
	if (a && b) return a === l.a && b === l.b ? l : { ...l, a, b };
	return a ?? b;
}

function replaceAt(l: Layout, id: string, fn: (p: Layout) => Layout): Layout {
	if (l.type === "pane") return l.sessionId === id ? fn(l) : l;
	return { ...l, a: replaceAt(l.a, id, fn), b: replaceAt(l.b, id, fn) };
}

/** Split `target`'s pane and put `id` on the given side of it. */
export function splitAt(l: Layout, target: string, id: string, edge: Edge): Layout {
	const dir = edge === "left" || edge === "right" ? "row" : "col";
	const first = edge === "left" || edge === "top";
	return replaceAt(l, target, (p) => ({
		type: "split",
		dir,
		ratio: 0.5,
		a: first ? pane(id) : p,
		b: first ? p : pane(id),
	}));
}

/** Put session `to` in the pane that shows `from`, leaving the rest of the layout as it is. */
export function replaceSession(l: Layout, from: string, to: string): Layout {
	return replaceAt(l, from, () => pane(to));
}

/** Exchange the positions of two sessions already in the layout. */
export function swap(l: Layout, x: string, y: string): Layout {
	if (l.type === "pane") return l.sessionId === x ? pane(y) : l.sessionId === y ? pane(x) : l;
	return { ...l, a: swap(l.a, x, y), b: swap(l.b, x, y) };
}

/**
 * Drop session `id` onto `target`'s pane. `id` may already be in the layout (moved) or come from outside (added).
 * Returns null when nothing would change.
 */
export function place(l: Layout, id: string, target: string, zone: Zone): Layout | null {
	if (id === target || !has(l, target)) return null;
	const without = has(l, id) ? remove(l, id) : l;
	return without && splitAt(without, target, id, zone);
}

export function setRatio(l: Layout, path: Path, ratio: number): Layout {
	const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
	if (!path.length) return l.type === "split" ? { ...l, ratio: r } : l;
	if (l.type !== "split") return l;
	const [head, ...rest] = path;
	return head === "a" ? { ...l, a: setRatio(l.a, rest, ratio) } : { ...l, b: setRatio(l.b, rest, ratio) };
}

const EPS = 1e-6;
const same = (a: Path, b: Path) => a.join("") === b.join("");

/** Where a divider's line sits, as a 0..1 fraction of the whole group (x for a vertical line, y for a horizontal one). */
export const positionOf = (d: Divider): number => (d.dir === "row" ? d.area.x + d.area.w * d.ratio : d.area.y + d.area.h * d.ratio);
const startOf = (d: Divider) => (d.dir === "row" ? d.area.x : d.area.y);
const sizeOf = (d: Divider) => (d.dir === "row" ? d.area.w : d.area.h);
/** The stretch of the line, along its own direction. */
const spanOf = (d: Divider): [number, number] => (d.dir === "row" ? [d.area.y, d.area.y + d.area.h] : [d.area.x, d.area.x + d.area.w]);

/**
 * Every divider that forms one continuous line with the one at `path`: same direction, same position, and joined
 * end to end (A|B over C|D: the two vertical halves). Independent of how the tree happens to be nested.
 * The first entry is `path` itself.
 */
export function linkedDividers(l: Layout, path: Path): Path[] {
	const all = measure(l).dividers;
	const me = all.find((d) => same(d.path, path));
	if (!me) return [path];
	const pos = positionOf(me);
	let rest = all.filter((d) => d !== me && d.dir === me.dir && Math.abs(positionOf(d) - pos) < EPS);
	const chain = [me];
	for (let grew = true; grew; ) {
		grew = false;
		for (const d of rest) {
			const [lo, hi] = spanOf(d);
			if (chain.some((c) => lo <= spanOf(c)[1] + EPS && hi >= spanOf(c)[0] - EPS)) {
				chain.push(d);
				rest = rest.filter((x) => x !== d);
				grew = true;
			}
		}
	}
	return chain.map((d) => d.path);
}

/** Put the dividers at `paths` on the same line, at `pos` (0..1 of the whole group), each kept within its own limits. */
export function moveDividers(l: Layout, paths: Path[], pos: number): Layout {
	const find = (t: Layout, p: Path) => measure(t).dividers.find((d) => same(d.path, p));
	const ds = paths.map((p) => find(l, p)).filter((d): d is Divider => !!d);
	if (!ds.length) return l;
	const lo = Math.max(...ds.map((d) => startOf(d) + sizeOf(d) * MIN_RATIO));
	const hi = Math.min(...ds.map((d) => startOf(d) + sizeOf(d) * MAX_RATIO));
	const target = lo <= hi ? Math.min(hi, Math.max(lo, pos)) : pos;
	let out = l;
	// Outer splits first: moving one changes the area its inner splits are measured in.
	for (const p of [...paths].sort((a, b) => a.length - b.length)) {
		const d = find(out, p);
		if (d) out = setRatio(out, p, (target - startOf(d)) / sizeOf(d));
	}
	return out;
}

/**
 * Pull `pos` onto a guide when it is within `threshold` (fraction of the group): the centre of the group or of the
 * divided area, quarters and thirds, and the lines of other dividers running the same way (to line things up).
 */
export function snapPosition(l: Layout, paths: Path[], pos: number, threshold = 0.02): number {
	const all = measure(l).dividers;
	const me = all.find((d) => paths.some((p) => same(d.path, p)));
	if (!me) return pos;
	const guides = [0.25, 1 / 3, 0.5, 2 / 3, 0.75].flatMap((f) => [f, startOf(me) + sizeOf(me) * f]);
	for (const d of all) if (d.dir === me.dir && !paths.some((p) => same(d.path, p))) guides.push(positionOf(d));
	let best = pos;
	let gap = threshold;
	for (const g of guides) if (Math.abs(g - pos) <= gap) ((best = g), (gap = Math.abs(g - pos)));
	return best;
}

function nodeAt(l: Layout, path: Path): Layout | null {
	let n: Layout = l;
	for (const step of path) {
		if (n.type !== "split") return null;
		n = step === "a" ? n.a : n.b;
	}
	return n;
}

function replaceNode(l: Layout, path: Path, next: Layout): Layout {
	if (!path.length) return next;
	if (l.type !== "split") return l;
	const [head, ...rest] = path;
	return head === "a" ? { ...l, a: replaceNode(l.a, rest, next) } : { ...l, b: replaceNode(l.b, rest, next) };
}

/**
 * Free one half of a divider. In a 2x2 grid built as "left column | right column", the vertical line is a single
 * node, so both halves move together. Turning the tree the other way ("top row over bottom row") gives that line
 * one segment per row; the two horizontal lines, once separate, become one (at their average). `side` 0 is the
 * first half (upper / left), 1 the second. Returns the new layout and the path of that half's divider, or null when
 * the divider is not between two splits that cross it (nothing to separate).
 */
export function detach(l: Layout, path: Path, side: 0 | 1): { layout: Layout; path: Path } | null {
	const n = nodeAt(l, path);
	if (!n || n.type !== "split" || n.a.type !== "split" || n.b.type !== "split") return null;
	const { a, b } = n;
	if (a.dir === n.dir || b.dir !== a.dir) return null;
	const row = (x: Layout, y: Layout): Layout => ({ type: "split", dir: n.dir, ratio: n.ratio, a: x, b: y });
	const turned: Layout = { type: "split", dir: a.dir, ratio: (a.ratio + b.ratio) / 2, a: row(a.a, b.a), b: row(a.b, b.b) };
	return { layout: replaceNode(l, path, turned), path: [...path, side ? "b" : "a"] };
}

/**
 * Which side of a pane a point is nearest to (x, y as 0..1 of the pane): the diagonals cut the pane into four
 * triangles. There is no middle zone, so anywhere on the pane splits it. A tie goes left, right, top, bottom.
 */
export function zoneAt(x: number, y: number): Zone {
	const dl = x, dr = 1 - x, dt = y, db = 1 - y;
	const m = Math.min(dl, dr, dt, db);
	return m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
}

/** A group needs two sessions to be worth having: with one left it dissolves (the server does the same). */
export const worthKeeping = (l: Layout | null): l is Layout => !!l && panesOf(l).length > 1;

/** Build a two-pane layout: `id` placed on `edge` of `target`. */
export const pair = (target: string, id: string, edge: Edge = "right"): Layout => splitAt(pane(target), target, id, edge);

/** Add a session beside everything already in the layout. */
export function append(l: Layout, id: string): Layout {
	const n = panesOf(l).length;
	return { type: "split", dir: "row", ratio: n / (n + 1), a: l, b: pane(id) };
}

/** Where each pane and divider sits, as fractions (0..1) of the whole area. Flat, so panes keep their identity when the tree changes. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}
export interface PaneBox extends Rect {
	id: string;
}
export interface Divider {
	path: Path;
	dir: "row" | "col";
	/** the split being resized: the divider sits inside this area */
	area: Rect;
	ratio: number;
}
/**
 * The pane next to `id` in the given direction: the nearest one whose span overlaps it, and of those the one
 * most in line with it. null at the edge of the group (or when `id` is not in the layout).
 */
export function paneToward(l: Layout, id: string, edge: Edge): string | null {
	const { panes } = measure(l);
	const me = panes.find((p) => p.id === id);
	if (!me) return null;
	const EPS = 1e-6;
	const horizontal = edge === "left" || edge === "right";
	let best: { id: string; gap: number; off: number } | null = null;
	for (const p of panes) {
		if (p.id === id) continue;
		const gap =
			edge === "right" ? p.x - (me.x + me.w)
			: edge === "left" ? me.x - (p.x + p.w)
			: edge === "bottom" ? p.y - (me.y + me.h)
			: me.y - (p.y + p.h);
		if (gap < -EPS) continue;
		const lo = horizontal ? Math.max(me.y, p.y) : Math.max(me.x, p.x);
		const hi = horizontal ? Math.min(me.y + me.h, p.y + p.h) : Math.min(me.x + me.w, p.x + p.w);
		if (hi - lo <= EPS) continue;
		const off = horizontal ? Math.abs(p.y + p.h / 2 - (me.y + me.h / 2)) : Math.abs(p.x + p.w / 2 - (me.x + me.w / 2));
		if (!best || gap < best.gap - EPS || (Math.abs(gap - best.gap) <= EPS && off < best.off)) best = { id: p.id, gap, off };
	}
	return best?.id ?? null;
}

export function measure(l: Layout, area: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: Path = []): { panes: PaneBox[]; dividers: Divider[] } {
	if (l.type === "pane") return { panes: [{ id: l.sessionId, ...area }], dividers: [] };
	const row = l.dir === "row";
	const first: Rect = row ? { ...area, w: area.w * l.ratio } : { ...area, h: area.h * l.ratio };
	const second: Rect = row
		? { x: area.x + first.w, y: area.y, w: area.w - first.w, h: area.h }
		: { x: area.x, y: area.y + first.h, w: area.w, h: area.h - first.h };
	const a = measure(l.a, first, [...path, "a"]);
	const b = measure(l.b, second, [...path, "b"]);
	return { panes: [...a.panes, ...b.panes], dividers: [{ path, dir: l.dir, area, ratio: l.ratio }, ...a.dividers, ...b.dividers] };
}
