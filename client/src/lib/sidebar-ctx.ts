import { getContext, setContext } from "svelte";
import type { DirSrc } from "./block-drag";
import type { DropOpts } from "./dnd.svelte";
import type { Point } from "./press-menu";
import type { DragMarks } from "./drag-marks.svelte";
import type { InlineRename } from "./inline-rename.svelte";
import type { DirBlock, Tab } from "./nav";
import type { RowTarget } from "./sidebar-model";
import type { Activity } from "./activity";
import type { Group, Session } from "./types";
import type { TerminalInfo } from "./terminal";
import type { Server } from "./store.svelte";

/** One server as the sidebar lists it. */
export interface SidebarNode {
	server: Server;
	current: boolean;
	state: "online" | "offline" | "unauthorized" | "incompatible" | "checking";
	loaded: boolean;
	root: string | undefined;
	home: string | undefined;
	total: number;
	dirs: DirBlock[];
	/** What the server runs (linux, darwin, win32), when it says so */
	platform: string | undefined;
}

/** What a row can be: a conversation, a terminal, or a split tab (group). */
export type MenuTarget = RowTarget & ({ kind: "session"; x: Session } | { kind: "terminal"; x: TerminalInfo } | { kind: "group"; g: Group });

/**
 * Everything the sidebar's rows share: the open "more" menu, the drag highlights, the two in-place renames, and the
 * handlers they call. The sidebar provides this once; each row component reads it instead of taking a dozen props,
 * eight of which would be the same for every row.
 */
export interface SidebarCtx {
	readonly marks: DragMarks;
	readonly rename: InlineRename;
	readonly groupRename: InlineRename;
	/** Id the "more" / "+" menu is open for (its button stays highlighted) */
	readonly menuId: string | null;
	readonly searching: boolean;
	/** Folded state of a tree node (folders, servers and split tabs never fold while searching) */
	isFolded(key: string): boolean;
	/** Activity of a conversation (other servers report running / waiting only) */
	stateOf(n: SidebarNode, x: Session): Activity;
	/** Row menu ("more" / "+") */
	hoverMenu(e: PointerEvent, target: MenuTarget): void;
	clickMenu(e: MouseEvent, target: MenuTarget, member?: boolean): void;
	/** Context menu (right click / long press) of a row, and of a folder (`path`) or server (`path` null) header; each returns how to close it */
	rowMenuAt(pt: Point, target: MenuTarget, member: boolean): () => void;
	headMenuAt(pt: Point, n: SidebarNode, path: string | null, key: string): () => void;
	leaveMenu(e: PointerEvent): void;
	hoverNew(e: PointerEvent, n: SidebarNode, path: string, key: string): void;
	clickNew(e: MouseEvent, n: SidebarNode, path: string, key: string): void;
	/** Renaming */
	startRename(id: string, title: string): void;
	commitRename(): void;
	startGroupRename(g: Group): void;
	commitGroupRename(): void;
	/** Dropping */
	memberTarget(n: SidebarNode, m: { id: string }): DropOpts;
	tabHover(d: DirBlock, x: Tab): (pt: { x: number; y: number } | null) => void;
	tabDropAt(n: SidebarNode, d: DirBlock, x: Tab): (id: string, pt: { x: number; y: number }) => Promise<void>;
	hover(key: string): (pt: unknown) => void;
	dropOnDir(id: string): void;
	/** Dragging a folder / server header (a Svelte action) */
	dirSource: (node: HTMLElement, opts: DirSrc) => { update: (next: DirSrc) => DirSrc; destroy(): void };
	/** Labels */
	pretty(n: SidebarNode, path: string): string;
	shortLabel(n: SidebarNode, path: string): string;
}

const KEY = Symbol("sidebar");
export const setSidebarCtx = (ctx: SidebarCtx): void => void setContext<SidebarCtx>(KEY, ctx);
export const getSidebarCtx = (): SidebarCtx => getContext<SidebarCtx>(KEY);
