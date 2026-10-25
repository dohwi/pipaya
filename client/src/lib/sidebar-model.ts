import { tilde } from "./format";
import type { DirBlock } from "./nav";

export type ServerState = "online" | "offline" | "unauthorized" | "incompatible" | "checking";

/** How the app's own connection state reads as a server's state in the sidebar. */
export function connectionState(net: string): ServerState {
	if (net === "online") return "online";
	if (net === "unauthorized" || net === "incompatible") return net;
	return net === "connecting" ? "checking" : "offline";
}

/** The states in which the server cannot be read, so its list is whatever was last seen. */
export const unreachable = (state: ServerState) => state === "offline" || state === "unauthorized" || state === "incompatible";

/** `~/workspace/x` as segments; each server has its own home. */
const segs = (path: string, home?: string) => tilde(path, home).split("/").filter(Boolean);

/** A folder's label: its own name, with as many parent names as it takes to tell it from the other folders. */
export function shortName(path: string, dirs: readonly Pick<DirBlock, "path">[], home?: string): string {
	const mine = segs(path, home);
	const others = dirs.filter((d) => d.path !== path).map((d) => segs(d.path, home));
	for (let k = 1; k < mine.length; k++) {
		const tail = mine.slice(-k).join("/");
		if (!others.some((o) => o.slice(-k).join("/") === tail)) return tail;
	}
	return mine.join("/") || tilde(path, home);
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
export type MenuIcon = "columns" | "pencil" | "x" | "unlink" | "chat" | "terminal" | "copy" | "chevron-down" | "chevron-right";

/** One entry of a row's "more" menu. */
export interface MenuEntry {
	icon: MenuIcon;
	label: string;
	/** Tooltip; "" for none */
	title: string;
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
	dissolveGroup(id: string): void;
	/** Take a pane out of its split tab (only offered for a `member`) */
	leaveGroup?(id: string): void;
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
			{ icon: "pencil", label: t("그룹 이름 바꾸기"), title: "", run: () => act.renameGroup(g) },
			{ icon: "unlink", label: t("그룹 해제"), title: t("그룹 해제 (대화는 그대로 남습니다)"), run: () => act.dissolveGroup(g.id) },
		];
	}
	const x = target.x;
	const close: MenuEntry =
		target.kind === "terminal"
			? { icon: "x", label: t("터미널 닫기"), title: t("셸을 종료합니다"), run: () => act.closeTerminal(x.id) }
			: { icon: "x", label: t("닫기"), title: t("닫기 (/resume 으로 다시 열기)"), run: () => act.closeSession(x.id) };
	const leave = act.leaveGroup;
	return [
		{ icon: "columns", label: t("다른 대화와 묶기"), title: "", run: () => act.groupWith(x) },
		{ icon: "pencil", label: t("이름 바꾸기"), title: "", run: () => act.renameTab(x.id, x.title) },
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
}

/** A folder or server header's context menu: what its "+" offers, then copying the path and folding. */
export function headMenuEntries(os: string | undefined, folded: boolean, act: HeadActions): MenuEntry[] {
	const copy = act.copyPath;
	return [
		...newMenuEntries(os, act),
		...(copy ? [{ icon: "copy", label: t("경로 복사"), title: "", run: copy } satisfies MenuEntry] : []),
		folded ? { icon: "chevron-down", label: t("펼치기"), title: "", run: act.toggle } : { icon: "chevron-right", label: t("접기"), title: "", run: act.toggle },
	];
}
