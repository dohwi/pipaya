import { nameSegs, tilde } from "./format";

export type ServerState = "online" | "offline" | "unauthorized" | "incompatible" | "checking";

/** How the app's own connection state reads as a server's state in the sidebar. */
export function connectionState(net: string): ServerState {
	if (net === "online") return "online";
	if (net === "unauthorized" || net === "incompatible") return net;
	return net === "connecting" ? "checking" : "offline";
}

/** The states in which the server cannot be read, so its list is whatever was last seen. */
export const unreachable = (state: ServerState) => state === "offline" || state === "unauthorized" || state === "incompatible";

/**
 * Where a server sits in the sidebar: the ones that are up first, then those still being checked (they may yet come up),
 * then the unreachable. Equal ranks keep the saved order (the sort is stable; the saved order is never rewritten).
 */
const serverRank = (state: ServerState) => (state === "online" ? 0 : state === "checking" ? 1 : 2);

/** The sidebar's server order: up, checking, unreachable; servers in the same state keep the order they were saved in. */
export const orderServers = <T extends { state: ServerState }>(servers: T[]): T[] => [...servers].sort((a, b) => serverRank(a.state) - serverRank(b.state));

/** A folder's label: its last two names (`~/work/app` -> `work/app`), the same on every OS; each server has its own home. */
export function shortName(path: string, home?: string): string {
	return nameSegs(path, home).slice(-2).join("/") || tilde(path, home);
}

/**
 * The dim path after a folder's label: where the folder sits, with the label's own tail cut off the end (`~/work/app`
 * shows `work/app` and then `~`), so the two never repeat the same text and read as one smeared, overlapping line.
 * A renamed folder's label is nowhere in its path, so it keeps the whole path: the pair still says two different things.
 */
export function parentPath(path: string, home: string | undefined, label: string): string {
	const pretty = tilde(path, home);
	const sep = pretty.includes("\\") ? "\\" : "/";
	const tail = label.replace(/[\\/]/g, sep);
	const cut = pretty.length - tail.length;
	if (!tail) return pretty;
	// the label is the whole path: nothing above it to show
	if (cut === 0) return "";
	// only a whole-segment match: a label that merely ends the path (`clone` in `meet-clone`) is not that folder's name
	if (!/[\\/]/.test(pretty[cut - 1]!)) return pretty;
	return pretty.slice(0, cut).replace(/[\\/]+$/, "");
}

/**
 * Where over a row a drag lands. The top and bottom of a row put the carried tab before / after it; the middle puts the
 * two together (`whole`: a carried group never goes into another group, so its middle counts as an edge too).
 */
export function edgeOf(y: number, rect: { top: number; bottom: number; height: number }, whole: boolean): "before" | "after" | null {
	const f = whole ? 0.5 : 0.28;
	if (y < rect.top + rect.height * f) return "before";
	if (y > rect.bottom - rect.height * f) return "after";
	return null;
}

/** The workdir value `openIn` expects: "." for the server default, else the absolute path. */
export const asWorkdir = (path: string, root: string | undefined) => (path === root ? "." : path);

/** Separator that cannot occur in a path or id, for keys that combine two of them. */
const SEP = "\u0000";
export const dirKey = (serverId: string, path: string) => `${serverId}${SEP}${path}`;
export const groupKey = (id: string) => `group${SEP}${id}`;
export const newKey = (key: string) => `new${SEP}${key}`;

import { t } from "./i18n";

/** The icons a row's menu uses (a subset of the app's icon names, so no component import is needed here). */
export type MenuIcon = "columns" | "pencil" | "x" | "unlink" | "chat" | "terminal" | "copy" | "chevron-down" | "chevron-right" | "pin";

/** One entry of a row's "more" menu. */
export interface MenuEntry {
	icon: MenuIcon;
	label: string;
	/** Tooltip; "" for none */
	title: string;
	/** Degrees to turn the icon (see RowMenuItem) */
	tilt?: number;
	run: () => void;
}

/** What a row's menu can act on: a conversation, a terminal, or a split tab (group). */
export type RowTarget = { kind: "session"; x: { id: string; title: string } } | { kind: "terminal"; x: { id: string; title: string } } | { kind: "group"; g: { id: string; name: string } };

/** What the menu entries do; the sidebar supplies these, so the entries themselves are plain data. */
export interface RowActions {
	renameTab(id: string, title: string): void;
	renameGroup(group: { id: string; name: string }): void;
	groupWith(tab: { id: string; title: string }): void;
	closeSession(id: string): void;
	closeTerminal(id: string): void;
	/** Dissolve a split tab. Only the sidebar passes it, and only the split tab's own row offers it: not its panes, the tab bar, the chips or the pane bars. */
	dissolveGroup?(id: string): void;
	/** Take a pane out of its split tab (only offered for a `member`) */
	leaveGroup?(id: string): void;
	/** Pin or unpin a tab (a conversation, terminal or whole split tab; the panes of a split tab follow it); `isPinned` says which the entry offers */
	togglePin?(id: string): void;
	isPinned?(id: string): boolean;
}

/** The pin entry of a tab's menu: a pinned tab stands upright, pinning drives the pin in at the slant a pinned folder's icon has. */
function pinEntry(id: string, act: RowActions): MenuEntry[] {
	const pin = act.togglePin;
	if (!pin) return [];
	const on = !!act.isPinned?.(id);
	return [{ icon: "pin", label: on ? t("고정 해제") : t("탭 고정"), title: t("고정하면 폴더의 맨 위에 남습니다"), tilt: on ? 0 : 35, run: () => pin(id) }];
}

/** The id the menu is open for, so the row's "more" button can stay highlighted. */
export const targetId = (target: RowTarget) => (target.kind === "group" ? target.g.id : target.x.id);

/**
 * The entries of a row's "more" menu (and its context menu): a split tab can be renamed or dissolved; a conversation or
 * terminal can be grouped, renamed and closed, and a pane of a split tab (`member`) taken out of it.
 */
export function rowMenuEntries(target: RowTarget, act: RowActions, member = false): MenuEntry[] {
	if (target.kind === "group") {
		const g = target.g;
		return [
			...pinEntry(g.id, act),
			{ icon: "pencil", label: t("그룹 이름 바꾸기"), title: "", run: () => act.renameGroup(g) },
			...(act.dissolveGroup ? [{ icon: "unlink", label: t("그룹 해제"), title: t("그룹 해제 (대화는 그대로 남습니다)"), run: () => act.dissolveGroup!(g.id) } satisfies MenuEntry] : []),
		];
	}
	const x = target.x;
	const close: MenuEntry =
		target.kind === "terminal"
			? { icon: "x", label: t("터미널 닫기"), title: t("셸을 종료합니다"), run: () => act.closeTerminal(x.id) }
			: { icon: "x", label: t("닫기"), title: t("닫기 (/resume 으로 다시 열기)"), run: () => act.closeSession(x.id) };
	const leave = act.leaveGroup;
	// most used first, grouping in the middle, and the way out (close) last
	return [
		{ icon: "pencil", label: t("이름 바꾸기"), title: "", run: () => act.renameTab(x.id, x.title) },
		// a pane of a split tab is pinned with its tab, not alone
		...(member ? [] : pinEntry(x.id, act)),
		{ icon: "columns", label: t("다른 대화와 묶기"), title: "", run: () => act.groupWith(x) },
		...(member && leave ? [{ icon: "unlink", label: t("그룹에서 빼기"), title: "", run: () => leave(x.id) } satisfies MenuEntry] : []),
		close,
	];
}

/** What the "+" of a server or folder does: start a conversation or a terminal, both in that place on that server. */
export interface NewActions {
	chat(): void;
	terminal(): void;
}

/** The "+" menu: a new conversation, and a new terminal named for the server's OS when it says what it runs. */
export function newMenuEntries(os: string | undefined, act: NewActions): MenuEntry[] {
	return [
		{ icon: "chat", label: t("새 대화"), title: "", run: act.chat },
		{
			icon: "terminal",
			label: os ? t("새 터미널 ({os})", { os }) : t("새 터미널"),
			title: t("서버의 셸을 이 폴더에서 엽니다 (Windows는 PowerShell)"),
			run: act.terminal,
		},
	];
}

/** What a folder or server header's context menu does besides the "+" entries. */
export interface HeadActions extends NewActions {
	/** Fold or unfold it; `folded` says which the entry offers */
	toggle(): void;
	/** Copy the folder's path (servers have none) */
	copyPath?(): void;
	/** Pin or unpin the folder (servers cannot be pinned); `pinned` says which the entry offers */
	togglePin?(): void;
	pinned?: boolean;
	/** Rename the folder in place (any folder) */
	rename?(): void;
}

/** A folder or server header's context menu: what its "+" offers, then copying the path and folding. */
export function headMenuEntries(os: string | undefined, folded: boolean, act: HeadActions): MenuEntry[] {
	const copy = act.copyPath;
	const pin = act.togglePin;
	return [
		...newMenuEntries(os, act),
		...(pin ? [{ icon: "pin", label: act.pinned ? t("고정 해제") : t("폴더 고정"), title: t("고정하면 안에 대화가 없어도 사이드바에 남습니다"), tilt: act.pinned ? 0 : 35, /* pinning drives the pin in at the same slant as a pinned folder's icon; unpinning stands it upright */ run: pin } satisfies MenuEntry] : []),
		...(act.rename ? [{ icon: "pencil", label: t("이름 바꾸기"), title: t("경로 대신 보일 이름을 붙입니다"), run: act.rename } satisfies MenuEntry] : []),
		...(copy ? [{ icon: "copy", label: t("경로 복사"), title: "", run: copy } satisfies MenuEntry] : []),
		folded ? { icon: "chevron-down", label: t("펼치기"), title: "", run: act.toggle } : { icon: "chevron-right", label: t("접기"), title: "", run: act.toggle },
	];
}
