import { panesOf } from "./layout";
import type { Group, Session } from "./types";

export interface GroupBlock {
	group: Group;
	sessions: Session[];
}
export interface DirBlock {
	path: string;
	sessions: Session[];
}

/**
 * The one place that decides how sessions are laid out: working directories first (hand-ordered, else most recently used first), then the
 * groups last (each with its panes in layout order). The sidebar, the folded rail and the
 * previous / next shortcuts all read this, so they can never disagree about the order.
 * `match` filters sessions (search); a group whose name matches (`matchGroup`) keeps all its members.
 * Groups left without members are kept: callers decide whether to show them.
 */
export function sidebarBlocks(
	sessions: readonly Session[],
	groups: readonly Group[],
	match: (s: Session) => boolean = () => true,
	matchGroup: (g: Group) => boolean = () => false,
	dirOrder: readonly string[] = [],
	groupOrder: readonly string[] = [],
): { groups: GroupBlock[]; dirs: DirBlock[] } {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	// a session in a group is listed there, not again under its directory
	const grouped = new Set<string>();
	const blocks: GroupBlock[] = [];
	for (const g of groups) {
		const members = panesOf(g.layout).map((id) => byId.get(id)).filter((s): s is Session => !!s);
		members.forEach((s) => grouped.add(s.id));
		blocks.push({ group: g, sessions: matchGroup(g) ? members : members.filter(match) });
	}
	const by = new Map<string, Session[]>();
	for (const s of sessions) {
		if (grouped.has(s.id) || !match(s)) continue;
		const list = by.get(s.cwd);
		if (list) list.push(s);
		else by.set(s.cwd, [s]);
	}
	const newest = (list: Session[]) => Math.max(...list.map((s) => s.updatedAt));
	// directories the user has placed by hand keep that order; the others (new ones) come first, most recent first
	const rank = (p: string) => dirOrder.indexOf(p);
	const dirs = [...by.entries()]
		.map(([path, list]) => ({ path, sessions: list }))
		.sort((a, b) => {
			const ra = rank(a.path);
			const rb = rank(b.path);
			if (ra >= 0 && rb >= 0) return ra - rb;
			if (ra >= 0) return 1;
			if (rb >= 0) return -1;
			return newest(b.sessions) - newest(a.sessions);
		});
	// groups placed by hand keep that order; new ones (not listed yet) land below them, in creation order
	const grank = (g: GroupBlock) => {
		const i = groupOrder.indexOf(g.group.id);
		return i < 0 ? Number.MAX_SAFE_INTEGER : i;
	};
	blocks.sort((a, b) => grank(a) - grank(b)); // stable: unlisted groups keep their creation order
	return { groups: blocks, dirs };
}

/** Session ids in the order the sidebar lists them. "Previous / next conversation" walks this. */
export function sessionOrder(sessions: readonly Session[], groups: readonly Group[], dirOrder: readonly string[] = [], groupOrder: readonly string[] = []): string[] {
	const { groups: gs, dirs } = sidebarBlocks(sessions, groups, undefined, undefined, dirOrder, groupOrder);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const b of [...dirs.map((d) => d.sessions), ...gs.map((g) => g.sessions)])
		for (const s of b) if (!seen.has(s.id)) (seen.add(s.id), out.push(s.id));
	return out;
}

/**
 * The first session in sidebar order that has finished (or failed) without being looked at, skipping the open one.
 * Opening a session clears its mark, so pressing again walks down the list.
 */
export function firstUnseen(order: readonly string[], marked: (id: string) => boolean, current: string | null): string | null {
	return order.find((id) => id !== current && marked(id)) ?? null;
}

/** The entry `step` places after `current` (wrapping). From nowhere (a new chat): forward starts at the first, back at the last. */
export function stepFrom(order: readonly string[], current: string | null, step: 1 | -1): string | null {
	if (!order.length) return null;
	const i = current ? order.indexOf(current) : -1;
	if (i < 0) return step === 1 ? order[0]! : order[order.length - 1]!;
	return order[(i + step + order.length) % order.length]!;
}
