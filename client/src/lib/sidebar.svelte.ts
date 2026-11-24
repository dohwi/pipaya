/**
 * The sidebar's own state: drawer open (phone), collapsed and width (desktop), which tree nodes are folded, and the
 * order the user dragged folders and tabs into (per server). Persisted on this device.
 */
import { clampTo } from "./number";
import { K, read, remove, write } from "./persist";
import type { ManualProject, ProjectOverrides } from "./projects";

export const SIDEBAR_W = { min: 220, max: 560, def: 288 };
const clamp = (n: number) => clampTo(Number.isFinite(n) ? Math.round(n) : n, SIDEBAR_W.min, SIDEBAR_W.max, SIDEBAR_W.def);

/** The stored width, or null when the user never set one (then `--sidebar-w` from `:root`, which a theme may set, decides). */
export function storedWidth(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw) : null;
}

function rootSidebarWidth(): string | undefined {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return undefined;
  return getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w");
}

/** The width `--sidebar-w` gives the page now (an extension theme's value or app.css), in px and within SIDEBAR_W like the
 * CSS that draws it (App.svelte, Sidebar.svelte); the default when unreadable. */
export function themeWidth(value: string | undefined = rootSidebarWidth()): number {
  const px = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value ?? "");
  return px ? clamp(Number(px[1])) : SIDEBAR_W.def;
}

/** Put `key` before/after `target` within `visible` (the entries as listed now). Null when nothing changes. */
export function reorder(visible: string[], key: string, target: string, after: boolean): string[] | null {
  if (key === target) return null;
  const list = visible.filter((p) => p !== key);
  const at = list.indexOf(target);
  if (at < 0) return null;
  list.splice(at + (after ? 1 : 0), 0, key);
  return list;
}

/** The part of the sidebar that follows the server (pins, folder names, hand-set order); folding and width stay on the device. */
export interface SidebarShared {
  pinnedDirs: string[];
  pinnedTabs: string[];
  dirOrder: string[];
  tabOrder: string[];
  dirNames: Record<string, string>;
  groupDir: Record<string, string>;
  /** Sent only when set: a server from before projects rejects a sidebar value with fields it does not know */
  projects?: ManualProject[];
  ungrouped?: string[];
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const projectList = (v: unknown): ManualProject[] =>
  Array.isArray(v)
    ? v
        .filter((p): p is ManualProject => !!p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.dirs))
        .map((p) => ({ id: p.id, name: p.name, dirs: strs(p.dirs) }))
        .filter((p) => p.dirs.length)
    : [];
const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

/**
 * Folders used to start open and be folded here by their `dirKey` ("<serverId>\u0000<path>"); they start folded now and
 * the opened ones are listed instead (`openDirs`). Old folder entries would only hide rows from the previous / next walk.
 */
export function withoutDirKeys(keys: string[]): string[] {
  return keys.filter((k) => !k.includes("\u0000") || k.startsWith("group\u0000") || k.startsWith("project\u0000") || k.startsWith("new\u0000"));
}

export class SidebarState {
  /** Told after the user edits a server's shared part, so it can be uploaded. */
  onEdit: (serverId: string) => void = () => {};

  /** The drawer on a narrow screen. */
  open = $state(false);
  collapsed = $state(read<boolean>(K.sidebar, false));
  /** The width the user dragged to, or null: follow `--sidebar-w` (app.css, or an extension theme). See `shownWidth`. */
  width = $state<number | null>(storedWidth(read<unknown>(K.sidebarW, null)));
  /** Folded servers, projects and split tabs. Folders are kept apart (`openDirs`): they start folded instead. */
  folded = $state<string[]>(withoutDirKeys(read<string[]>(K.folded, [])));
  /**
   * Folders opened to list their tabs, by `dirKey`. Folders start folded: the tab bar lists the open folder's tabs, so the
   * sidebar stays a list of places and a folder shows its tabs only when the user opens it.
   */
  openDirs = $state<string[]>(read<string[]>(K.openDirs, []));
  /**
   * Folders inside a project folded by hand, by `dirKey`. A project's folders (its branches) start open instead: the
   * project header already folds them all at once, so a second fold on each branch would only hide its tabs twice.
   */
  foldedProjectDirs = $state<string[]>(read<string[]>(K.foldedProjectDirs, []));
  dirOrder = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.dirOrder, {}));
  /** Folders pinned per server: they stay listed with no tabs in them. */
  pinned = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.pinnedDirs, {}));
  /** Names given to pinned folders per server, shown in place of the path's tail (the path still sits beside it). Dropped on unpin. */
  dirNames = $state<Record<string, Record<string, string>>>(read<Record<string, Record<string, string>>>(K.dirNames, {}));
  /** Tabs pinned per server: they sit at the top of their folder, in their own order. A split tab is pinned as a whole. */
  pinnedTabs = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.pinnedTabs, {}));
  /** Order of the tabs (group / session / terminal ids) set by dragging, per server; ranks tabs within their directory. */
  tabOrder = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.tabOrder, {}));

  /** Projects the user made by hand, per server (they win over the git grouping). */
  projects = $state<Record<string, ManualProject[]>>(read<Record<string, ManualProject[]>>(K.projects, {}));
  /** Folders taken out of their git repository's project, per server. */
  ungrouped = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.ungrouped, {}));

  overrides(serverId: string): ProjectOverrides {
    return { projects: this.projects[serverId] ?? [], ungrouped: this.ungrouped[serverId] ?? [] };
  }

  /** Keep what `projects.ts` (joinProject, leaveProject, dissolveProject) worked out for a server. */
  setOverrides(serverId: string, o: Required<ProjectOverrides>) {
    this.projects = { ...this.projects, [serverId]: [...o.projects] };
    this.ungrouped = { ...this.ungrouped, [serverId]: [...o.ungrouped] };
    write(K.projects, this.projects);
    write(K.ungrouped, this.ungrouped);
    this.onEdit(serverId);
  }

  /** Name a hand-made project; blank keeps the old name. */
  renameProject(serverId: string, id: string, name: string) {
    const v = name.trim();
    if (!v) return;
    this.projects = { ...this.projects, [serverId]: (this.projects[serverId] ?? []).map((p) => (p.id === id ? { ...p, name: v } : p)) };
    write(K.projects, this.projects);
    this.onEdit(serverId);
  }

  /** Folder each group is listed under, per server: fixed when first seen so adding or closing panes cannot move the group. */
  groupDir = $state<Record<string, Record<string, string>>>(read<Record<string, Record<string, string>>>(K.groupDir, {}));

  /** The width on screen in px: the user's own, else the theme's. */
  shownWidth(): number {
    return this.width ?? themeWidth();
  }

  /** `save` false while dragging the edge: persist once, at the end. */
  setWidth(px: number, save = true) {
    this.width = clamp(px);
    if (save) write(K.sidebarW, this.width);
  }

  /** Back to the theme's width (double click on the edge): the stored width is forgotten. */
  resetWidth() {
    this.width = null;
    remove(K.sidebarW);
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    write(K.sidebar, this.collapsed);
  }

  toggleFolded(key: string) {
    this.folded = this.folded.includes(key) ? this.folded.filter((p) => p !== key) : [...this.folded, key];
    write(K.folded, this.folded);
  }

  /** `inProject`: the folder is listed under a project header (it starts open there, see `foldedProjectDirs`). */
  isDirFolded(key: string, inProject = false): boolean {
    return inProject ? this.foldedProjectDirs.includes(key) : !this.openDirs.includes(key);
  }

  toggleDir(key: string, inProject = false) {
    if (inProject) {
      this.foldedProjectDirs = this.foldedProjectDirs.includes(key) ? this.foldedProjectDirs.filter((p) => p !== key) : [...this.foldedProjectDirs, key];
      write(K.foldedProjectDirs, this.foldedProjectDirs);
      return;
    }
    this.openDirs = this.openDirs.includes(key) ? this.openDirs.filter((p) => p !== key) : [...this.openDirs, key];
    write(K.openDirs, this.openDirs);
  }

  /** Open or fold every folder of a project at once (`keys`: their `dirKey`s); the project header's menu offers it. */
  setProjectDirsFolded(keys: readonly string[], folded: boolean) {
    const rest = this.foldedProjectDirs.filter((p) => !keys.includes(p));
    this.foldedProjectDirs = folded ? [...rest, ...keys] : rest;
    write(K.foldedProjectDirs, this.foldedProjectDirs);
  }

  /**
   * Unfold the one node that holds `key` (a server's id or a project's key), so the row it stands for can be seen when
   * something opens in it. Folders are left as they are: the open folder's row is marked, and the tab bar lists its tabs.
   */
  reveal(key: string) {
    if (!this.folded.includes(key)) return;
    this.folded = this.folded.filter((p) => p !== key);
    write(K.folded, this.folded);
  }

  isPinned(serverId: string, path: string): boolean {
    return (this.pinned[serverId] ?? []).includes(path);
  }

  togglePinned(serverId: string, path: string) {
    const list = this.pinned[serverId] ?? [];
    this.pinned = { ...this.pinned, [serverId]: list.includes(path) ? list.filter((p) => p !== path) : [...list, path] };
    write(K.pinnedDirs, this.pinned);
    this.onEdit(serverId);
  }

  dirName(serverId: string, path: string): string | undefined {
    return this.dirNames[serverId]?.[path];
  }

  /** Name a pinned folder; a blank name goes back to the default label. */
  setDirName(serverId: string, path: string, name: string) {
    const { [path]: _, ...rest } = this.dirNames[serverId] ?? {};
    const next = name.trim() ? { ...rest, [path]: name.trim() } : rest;
    this.dirNames = { ...this.dirNames, [serverId]: next };
    write(K.dirNames, this.dirNames);
    this.onEdit(serverId);
  }

  isTabPinned(serverId: string, id: string): boolean {
    return (this.pinnedTabs[serverId] ?? []).includes(id);
  }

  toggleTabPinned(serverId: string, id: string) {
    const list = this.pinnedTabs[serverId] ?? [];
    this.pinnedTabs = { ...this.pinnedTabs, [serverId]: list.includes(id) ? list.filter((p) => p !== id) : [...list, id] };
    write(K.pinnedTabs, this.pinnedTabs);
    this.onEdit(serverId);
  }

  private dropFromList(map: Record<string, string[]>, serverId: string, id: string): Record<string, string[]> | null {
    const list = map[serverId];
    if (!list?.includes(id)) return null;
    const next = list.filter((p) => p !== id);
    if (next.length) return { ...map, [serverId]: next };
    const { [serverId]: _, ...rest } = map;
    return rest;
  }

  /** Unpin a tab if it is pinned (e.g. when a session is closed, so resuming it later does not auto-pin it). */
  unpinTab(serverId: string, id: string) {
    if (!serverId || !id) return;
    const next = this.dropFromList(this.pinnedTabs, serverId, id);
    if (!next) return;
    this.pinnedTabs = next;
    write(K.pinnedTabs, this.pinnedTabs);
    this.onEdit(serverId);
  }

  /** Drop pinned tab ids that are no longer among the server's active sessions, groups, or terminals. */
  prunePinnedTabs(serverId: string, activeIds: ReadonlySet<string>) {
    if (!serverId) return;
    const list = this.pinnedTabs[serverId];
    if (!list?.length) return;
    const next = list.filter((id) => activeIds.has(id));
    if (next.length === list.length) return;
    if (next.length) this.pinnedTabs = { ...this.pinnedTabs, [serverId]: next };
    else {
      const { [serverId]: _, ...rest } = this.pinnedTabs;
      this.pinnedTabs = rest;
    }
    write(K.pinnedTabs, this.pinnedTabs);
    this.onEdit(serverId);
  }

  /** Forget a permanently removed tab (deleted session, closed terminal, or dissolved group) from sidebar state. */
  forgetTab(serverId: string, id: string) {
    if (!serverId || !id) return;
    let sharedChanged = false;
    const nextPinned = this.dropFromList(this.pinnedTabs, serverId, id);
    if (nextPinned) {
      this.pinnedTabs = nextPinned;
      write(K.pinnedTabs, this.pinnedTabs);
      sharedChanged = true;
    }
    const nextOrder = this.dropFromList(this.tabOrder, serverId, id);
    if (nextOrder) {
      this.tabOrder = nextOrder;
      write(K.tabOrder, this.tabOrder);
      sharedChanged = true;
    }
    const gdir = this.groupDir[serverId];
    if (gdir && Object.hasOwn(gdir, id)) {
      const { [id]: _, ...rest } = gdir;
      if (Object.keys(rest).length) this.groupDir = { ...this.groupDir, [serverId]: rest };
      else {
        const { [serverId]: __, ...allRest } = this.groupDir;
        this.groupDir = allRest;
      }
      write(K.groupDir, this.groupDir);
      sharedChanged = true;
    }
    const gkey = `group\u0000${id}`;
    if (this.folded.includes(gkey)) {
      this.folded = this.folded.filter((p) => p !== gkey);
      write(K.folded, this.folded);
    }
    if (sharedChanged) this.onEdit(serverId);
  }

  /** Put directory `path` before/after `target` within `visible` (the directories as listed now) and remember it. */
  moveDir(serverId: string, visible: string[], path: string, target: string, after: boolean) {
    const list = reorder(visible, path, target, after);
    if (!list) return;
    // keep the rank of folders not listed now (filtered out, or without tabs) so they don't fall back to the age rule
    const rest = (this.dirOrder[serverId] ?? []).filter((x) => !list.includes(x));
    this.dirOrder = { ...this.dirOrder, [serverId]: [...list, ...rest] };
    write(K.dirOrder, this.dirOrder);
    this.onEdit(serverId);
  }

  /** Put tab `id` before/after `target` among the tabs of one directory (`visible`, as listed now) and remember it. */
  moveTab(serverId: string, visible: string[], id: string, target: string, after: boolean) {
    const list = reorder(visible, id, target, after);
    if (!list) return;
    const rest = (this.tabOrder[serverId] ?? []).filter((x) => !list.includes(x));
    this.tabOrder = { ...this.tabOrder, [serverId]: [...rest, ...list] };
    write(K.tabOrder, this.tabOrder);
    this.onEdit(serverId);
  }

  /**
   * Freeze what is listed now: directories and tabs not placed yet are appended in their current order, so closing,
   * grouping or searching later can never make them jump. Already placed entries (even gone ones) keep their rank.
   */
  pin(serverId: string, dirs: string[], tabs: string[], groups: Record<string, string> = {}) {
    const g = this.groupDir[serverId] ?? {};
    const changed = Object.entries(groups).filter(([id, cwd]) => g[id] !== cwd);
    if (changed.length) {
      this.groupDir = { ...this.groupDir, [serverId]: { ...g, ...Object.fromEntries(changed) } };
      write(K.groupDir, this.groupDir);
    this.onEdit(serverId);
    }
    // sets, not `includes` per entry: this runs on every list change, with the whole session list as `tabs`
    const d = this.dirOrder[serverId] ?? [];
    const haveDirs = new Set(d);
    const newDirs = dirs.filter((p) => !haveDirs.has(p));
    if (newDirs.length) {
      this.dirOrder = { ...this.dirOrder, [serverId]: [...d, ...newDirs] };
      write(K.dirOrder, this.dirOrder);
    this.onEdit(serverId);
    }
    const t = this.tabOrder[serverId] ?? [];
    const haveTabs = new Set(t);
    const newTabs = tabs.filter((x) => !haveTabs.has(x));
    if (newTabs.length) {
      this.tabOrder = { ...this.tabOrder, [serverId]: [...t, ...newTabs] };
      write(K.tabOrder, this.tabOrder);
    this.onEdit(serverId);
    }
  }

  /** Remember `list` (the tabs of one directory, in order) as placed by hand. */
  placeTabs(serverId: string, list: string[]) {
    const rest = (this.tabOrder[serverId] ?? []).filter((x) => !list.includes(x));
    this.tabOrder = { ...this.tabOrder, [serverId]: [...rest, ...list] };
    write(K.tabOrder, this.tabOrder);
    this.onEdit(serverId);
  }

  /** This device's shared part for a server; `undefined` while it never kept any (nothing to offer a fresh server). */
  shared(serverId: string): SidebarShared | undefined {
    const o: SidebarShared = {
      pinnedDirs: this.pinned[serverId] ?? [],
      pinnedTabs: this.pinnedTabs[serverId] ?? [],
      dirOrder: this.dirOrder[serverId] ?? [],
      tabOrder: this.tabOrder[serverId] ?? [],
      dirNames: this.dirNames[serverId] ?? {},
      groupDir: this.groupDir[serverId] ?? {},
    };
    const projects = this.projects[serverId] ?? [];
    const ungrouped = this.ungrouped[serverId] ?? [];
    if (projects.length) o.projects = projects;
    if (ungrouped.length) o.ungrouped = ungrouped;
    const empty = !o.pinnedDirs.length && !o.pinnedTabs.length && !o.dirOrder.length && !o.tabOrder.length && !Object.keys(o.dirNames).length && !Object.keys(o.groupDir).length && !projects.length && !ungrouped.length;
    return empty ? undefined : o;
  }

  /** Show what the server holds for `serverId`, and keep it on this device. */
  applyShared(serverId: string, v: unknown) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    this.pinned = { ...this.pinned, [serverId]: strs(o.pinnedDirs) };
    this.pinnedTabs = { ...this.pinnedTabs, [serverId]: strs(o.pinnedTabs) };
    this.dirOrder = { ...this.dirOrder, [serverId]: strs(o.dirOrder) };
    this.tabOrder = { ...this.tabOrder, [serverId]: strs(o.tabOrder) };
    this.dirNames = { ...this.dirNames, [serverId]: strMap(o.dirNames) };
    this.groupDir = { ...this.groupDir, [serverId]: strMap(o.groupDir) };
    this.projects = { ...this.projects, [serverId]: projectList(o.projects) };
    this.ungrouped = { ...this.ungrouped, [serverId]: strs(o.ungrouped) };
    write(K.projects, this.projects);
    write(K.ungrouped, this.ungrouped);
    write(K.pinnedDirs, this.pinned);
    write(K.pinnedTabs, this.pinnedTabs);
    write(K.dirOrder, this.dirOrder);
    write(K.tabOrder, this.tabOrder);
    write(K.dirNames, this.dirNames);
    write(K.groupDir, this.groupDir);
  }
}
