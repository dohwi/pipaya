import { panesOf } from "./layout";
import type { TerminalInfo } from "./terminal";
import type { Group, Session } from "./types";

export interface GroupBlock {
	group: Group;
	sessions: Session[];
	/** Terminals in the group, listed after its conversations */
	terminals: TerminalInfo[];
}
export interface DirBlock {
	path: string;
	sessions: Session[];
	/** Terminals started in this directory and not in a group */
	terminals: TerminalInfo[];
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
	terminals: readonly TerminalInfo[] = [],
	matchTerminal: (t: TerminalInfo) => boolean = () => true,
	sessionOrder: readonly string[] = [],
): { groups: GroupBlock[]; dirs: DirBlock[] } {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	const termById = new Map(terminals.map((t) => [t.id, t]));
	// a session in a group is listed there, not again under its directory
	const grouped = new Set<string>();
	const blocks: GroupBlock[] = [];
	for (const g of groups) {
		const ids = panesOf(g.layout);
		const members = ids.map((id) => byId.get(id)).filter((s): s is Session => !!s);
		const terms = ids.map((id) => termById.get(id)).filter((t): t is TerminalInfo => !!t);
		members.forEach((s) => grouped.add(s.id));
		terms.forEach((t) => grouped.add(t.id));
		const all = matchGroup(g);
		blocks.push({ group: g, sessions: all ? members : members.filter(match), terminals: all ? terms : terms.filter(matchTerminal) });
	}
	const by = new Map<string, Session[]>();
	const termsBy = new Map<string, TerminalInfo[]>();
	for (const s of sessions) {
		if (grouped.has(s.id) || !match(s)) continue;
		const list = by.get(s.cwd);
		if (list) list.push(s);
		else by.set(s.cwd, [s]);
	}
	for (const t of terminals) {
		if (grouped.has(t.id) || !matchTerminal(t)) continue;
		if (!by.has(t.cwd)) by.set(t.cwd, []);
		const list = termsBy.get(t.cwd);
		if (list) list.push(t);
		else termsBy.set(t.cwd, [t]);
	}
	// sessions placed by hand keep that order within their directory; the others (new ones) come first
	if (sessionOrder.length) {
		const srank = (s: Session) => sessionOrder.indexOf(s.id); // -1 (not placed yet) sorts first
		for (const list of by.values()) list.sort((a, b) => srank(a) - srank(b)); // stable
	}
	const newest = (path: string, list: Session[]) => Math.max(0, ...list.map((s) => s.updatedAt), ...(termsBy.get(path) ?? []).map((t) => t.createdAt));
	// directories the user has placed by hand keep that order; the others (new ones) come first, most recent first
	const rank = (p: string) => dirOrder.indexOf(p);
	const dirs = [...by.entries()]
		.map(([path, list]) => ({ path, sessions: list, terminals: termsBy.get(path) ?? [] }))
		.sort((a, b) => {
			const ra = rank(a.path);
			const rb = rank(b.path);
			if (ra >= 0 && rb >= 0) return ra - rb;
			if (ra >= 0) return 1;
			if (rb >= 0) return -1;
			return newest(b.path, b.sessions) - newest(a.path, a.sessions);
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
export function sessionOrder(sessions: readonly Session[], groups: readonly Group[], dirOrder: readonly string[] = [], groupOrder: readonly string[] = [], terminals: readonly TerminalInfo[] = [], sessionRank: readonly string[] = []): string[] {
	const { groups: gs, dirs } = sidebarBlocks(sessions, groups, undefined, undefined, dirOrder, groupOrder, terminals, undefined, sessionRank);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const b of [...dirs.map((d) => [...d.sessions, ...d.terminals]), ...gs.map((g) => [...g.sessions, ...g.terminals])])
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
