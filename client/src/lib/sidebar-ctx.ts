import { getContext, setContext } from "svelte";
import type { DirSrc } from "./block-drag";
import type { DropOpts } from "./dnd.svelte";
import type { Point } from "./press-menu";
import type { DragMarks } from "./drag-marks.svelte";
import type { InlineRename } from "./inline-rename.svelte";
import type { DirBlock, Tab } from "./nav";
import type { RepoInfo, SidebarBlock } from "./projects";
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
	/** The lists are this device's copy from the last visit, not yet confirmed by the server (see list-cache) */
	stale: boolean;
	root: string | undefined;
	home: string | undefined;
	total: number;
	dirs: DirBlock[];
	/** The same folders as listed: plain folders, and projects holding a repository's folders together */
	blocks: SidebarBlock[];
	/** The git repository of each folder, as far as the server said */
	repos: Readonly<Record<string, RepoInfo | null>>;
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
	/** The pinned folder being renamed (its dir key) */
	readonly dirRename: InlineRename;
	commitDirRename(n: SidebarNode, path: string): void;
	/** The project header being renamed (its project key) */
	readonly projectRename: InlineRename;
	commitProjectRename(n: SidebarNode, root: string): void;
	/** Context menu of a project header; returns how to close it */
	projectMenuAt(pt: Point, n: SidebarNode, root: string, key: string, workdir: string): () => void;
	/** A project's label (a hand-made one's name, else the repository folder's) */
	projectName(n: SidebarNode, root: string): string;
	/** Id the "more" / "+" menu is open for (its button stays highlighted) */
	readonly menuId: string | null;
	/** Folded state of a server, project or split tab */
	isFolded(key: string): boolean;
	/** Folded state of a folder: folders start folded and list their tabs only once opened; inside a project they start open */
	isDirFolded(key: string, inProject?: boolean): boolean;
	/** Activity of a conversation, from its own server's live state */
	stateOf(n: SidebarNode, x: Session): Activity;
	/** Activity by id (a terminal or an unknown id is idle) */
	stateOfId(n: SidebarNode, id: string): Activity;
	/** Row menu ("more" / "+") */
	hoverMenu(e: PointerEvent, n: SidebarNode, target: MenuTarget, member?: boolean): void;
	clickMenu(e: MouseEvent, n: SidebarNode, target: MenuTarget, member?: boolean): void;
	/** Context menu (right click / long press) of a row, and of a folder (`path`) or server (`path` null) header; each returns how to close it */
	rowMenuAt(pt: Point, n: SidebarNode, target: MenuTarget, member: boolean): () => void;
	headMenuAt(pt: Point, n: SidebarNode, path: string | null, key: string): () => void;
	leaveMenu(e: PointerEvent): void;
	hoverNew(e: PointerEvent, n: SidebarNode, path: string, key: string): void;
	clickNew(e: MouseEvent, n: SidebarNode, path: string, key: string): void;
	/** Renaming */
	startRename(id: string, title: string, serverId?: string): void;
	commitRename(): void;
	startGroupRename(g: Group, serverId?: string): void;
	commitGroupRename(): void;
	/** Dropping */
	memberTarget(n: SidebarNode, m: { id: string }): DropOpts;
	tabHover(n: SidebarNode, d: DirBlock, x: Tab): (pt: { x: number; y: number } | null) => void;
	tabDropAt(n: SidebarNode, d: DirBlock, x: Tab): (id: string, pt: { x: number; y: number }) => Promise<void>;
	hover(key: string): (pt: unknown) => void;
	/** Something let go on folder `path`: a split-tab pane steps out of its group; a lone conversation moves to work there */
	dropOnDir(n: SidebarNode, path: string): (id: string) => void;
	/** Whether `id` may be dropped on folder `path` (see dropOnDir) */
	acceptsOnDir(n: SidebarNode, path: string): (id: string) => boolean;
	/** Dragging a folder / server header (a Svelte action) */
	dirSource: (node: HTMLElement, opts: DirSrc) => { update: (next: DirSrc) => DirSrc; destroy(): void };
	/** Labels */
	pretty(n: SidebarNode, path: string): string;
	shortLabel(n: SidebarNode, path: string): string;
}

const KEY = Symbol("sidebar");
export const setSidebarCtx = (ctx: SidebarCtx): void => void setContext<SidebarCtx>(KEY, ctx);
export const getSidebarCtx = (): SidebarCtx => getContext<SidebarCtx>(KEY);
