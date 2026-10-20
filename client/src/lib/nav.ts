import { panesOf } from "./layout";
import type { TerminalInfo } from "./terminal";
import type { Group, Session } from "./types";

/** Something a pane can show: a conversation or a terminal. */
export type Member = Session | TerminalInfo;

/**
 * One tab of a working directory: a group (several panes laid out together), a lone conversation, or a lone terminal.
 * A session or terminal in a group is part of that group's tab only.
 */
export type Tab =
	| { kind: "group"; id: string; group: Group; members: Member[] }
	| { kind: "session"; id: string; session: Session }
	| { kind: "terminal"; id: string; terminal: TerminalInfo };

export interface DirBlock {
	path: string;
	tabs: Tab[];
}

/** The panes a tab shows, in layout order. */
export const tabPanes = (t: Tab): string[] => (t.kind === "group" ? t.members.map((m) => m.id) : [t.id]);

export interface BlockOpts {
	/** search on conversations */
	match?: (s: Session) => boolean;
	/** search on group names: a group that matches keeps all its members */
	matchGroup?: (g: Group) => boolean;
	matchTerminal?: (t: TerminalInfo) => boolean;
	/** directories placed by hand */
	dirOrder?: readonly string[];
	/** tabs (group / session / terminal ids) placed by hand, across all directories */
	tabOrder?: readonly string[];
}

/** The folder a group belongs to: the one most of its panes work in (ties: the first pane's). */
function dirOf(members: Member[]): string {
	const n = new Map<string, number>();
	for (const m of members) n.set(m.cwd, (n.get(m.cwd) ?? 0) + 1);
	let best = members[0]!.cwd;
	for (const m of members) if (n.get(m.cwd)! > n.get(best)!) best = m.cwd;
	return best;
}

/**
 * The one place that decides how things are laid out: working directories (hand-ordered, else the order they were first opened in), each with its tabs (hand-ordered, the others after them in the order they were made). The sidebar, the tab
 * bar, the folded rail and the previous / next shortcuts all read this, so they can never disagree about the order.
 * Groups without any member left are skipped (the server dissolves them).
 */
export function sidebarDirs(sessions: readonly Session[], groups: readonly Group[], terminals: readonly TerminalInfo[] = [], o: BlockOpts = {}): DirBlock[] {
	const match = o.match ?? (() => true);
	const matchTerminal = o.matchTerminal ?? (() => true);
	const matchGroup = o.matchGroup ?? (() => false);
	const termIds = new Set(terminals.map((t) => t.id));
	const byId = new Map<string, Member>([...sessions.map((s) => [s.id, s] as const), ...terminals.map((t) => [t.id, t] as const)]);
	const matches = (m: Member) => (termIds.has(m.id) ? matchTerminal(m as TerminalInfo) : match(m as Session));
	const grouped = new Set<string>();
	const all: { cwd: string; tab: Tab; created: number }[] = [];
	for (const g of groups) {
		const members = panesOf(g.layout)
			.map((id) => byId.get(id))
			.filter((m): m is Member => !!m);
		if (!members.length) continue;
		members.forEach((m) => grouped.add(m.id));
		const shown = matchGroup(g) ? members : members.filter(matches);
		if (!shown.length) continue;
		all.push({ cwd: dirOf(members), tab: { kind: "group", id: g.id, group: g, members: shown }, created: g.createdAt ?? 0 });
	}
	for (const s of sessions) {
		if (grouped.has(s.id) || !match(s)) continue;
		all.push({ cwd: s.cwd, tab: { kind: "session", id: s.id, session: s }, created: s.createdAt ?? 0 });
	}
	for (const t of terminals) {
		if (grouped.has(t.id) || !matchTerminal(t)) continue;
		all.push({ cwd: t.cwd, tab: { kind: "terminal", id: t.id, terminal: t }, created: t.createdAt ?? 0 });
	}
	const tabOrder = o.tabOrder ?? [];
	const trank = (id: string) => {
		const i = tabOrder.indexOf(id);
		return i < 0 ? Number.MAX_SAFE_INTEGER : i;
	};
	// placed tabs keep their place; new ones go after them, oldest first (a new tab lands at the end, like an editor's)
	all.sort((a, b) => trank(a.tab.id) - trank(b.tab.id) || a.created - b.created);
	const by = new Map<string, { tabs: Tab[]; first: number }>();
	for (const x of all) {
		const d = by.get(x.cwd);
		if (d) (d.tabs.push(x.tab), (d.first = Math.min(d.first, x.created)));
		else by.set(x.cwd, { tabs: [x.tab], first: x.created });
	}
	const dirOrder = o.dirOrder ?? [];
	const rank = (p: string) => dirOrder.indexOf(p);
	return [...by.entries()]
		.sort(([pa, a], [pb, b]) => {
			const ra = rank(pa);
			const rb = rank(pb);
			if (ra >= 0 && rb >= 0) return ra - rb;
			if (ra >= 0) return -1;
			if (rb >= 0) return 1;
			// not placed by hand: stable, the longer a directory has been open the higher it sits (new ones stack at the bottom)
			return a.first - b.first;
		})
		.map(([path, d]) => ({ path, tabs: d.tabs }));
}

/** The tab showing pane `id` (a session or terminal id, or a group id), if any. */
export function tabOf(dirs: readonly DirBlock[], id: string | null | undefined): { dir: DirBlock; tab: Tab } | null {
	if (!id) return null;
	for (const dir of dirs) for (const tab of dir.tabs) if (tab.id === id || tabPanes(tab).includes(id)) return { dir, tab };
	return null;
}

/** Session and terminal ids in the order the sidebar lists them. "Previous / next conversation" walks this. */
export function sessionOrder(sessions: readonly Session[], groups: readonly Group[], dirOrder: readonly string[] = [], tabOrder: readonly string[] = [], terminals: readonly TerminalInfo[] = []): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const d of sidebarDirs(sessions, groups, terminals, { dirOrder, tabOrder }))
		for (const t of d.tabs) for (const id of tabPanes(t)) if (!seen.has(id)) (seen.add(id), out.push(id));
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

/** The first pane of the folder `step` places after the one holding `current` (wrapping). From nowhere: forward starts at the first folder, back at the last. */
export function stepDir(dirs: readonly DirBlock[], current: string | null, step: 1 | -1): string | null {
	const list = dirs.filter((d) => d.tabs.some((t) => tabPanes(t).length));
	if (!list.length) return null;
	const at = current ? list.findIndex((d) => d.tabs.some((t) => t.id === current || tabPanes(t).includes(current))) : -1;
	const to = at < 0 ? (step === 1 ? list[0]! : list[list.length - 1]!) : list[(at + step + list.length) % list.length]!;
	for (const t of to.tabs) {
		const pane = tabPanes(t)[0];
		if (pane) return pane;
	}
	return null;
}
