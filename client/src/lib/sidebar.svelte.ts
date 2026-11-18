/**
 * The sidebar's own state: drawer open (phone), collapsed and width (desktop), which tree nodes are folded, and the
 * order the user dragged folders and tabs into (per server). Persisted on this device.
 */
import { clampTo } from "./number";
import { K, read, write } from "./persist";
import type { ManualProject, ProjectOverrides } from "./projects";

export const SIDEBAR_W = { min: 220, max: 560, def: 288 };
const clamp = (n: number) => clampTo(Number.isFinite(n) ? Math.round(n) : n, SIDEBAR_W.min, SIDEBAR_W.max, SIDEBAR_W.def);

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
  width = $state(clamp(read<number>(K.sidebarW, SIDEBAR_W.def)));
  /** Folded servers, projects and split tabs. Folders are kept apart (`openDirs`): they start folded instead. */
  folded = $state<string[]>(withoutDirKeys(read<string[]>(K.folded, [])));
  /**
   * Folders opened by hand to list their tabs, by `dirKey`. Other folders start folded, so the sidebar stays a list of
   * places; only the folder of what is open shows its tabs on its own (`autoDir`).
   */
  openDirs = $state<string[]>(read<string[]>(K.openDirs, []));
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

  /** `save` false while dragging the edge: persist once, at the end. */
  setWidth(px: number, save = true) {
    this.width = clamp(px);
    if (save) write(K.sidebarW, this.width);
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    write(K.sidebar, this.collapsed);
  }

  toggleFolded(key: string) {
    this.folded = this.folded.includes(key) ? this.folded.filter((p) => p !== key) : [...this.folded, key];
    write(K.folded, this.folded);
  }

  /**
   * The folder of what is open now (`dirKey`, null on the graph or with no server): it shows its tabs without being in
   * `openDirs`, and folds again once focus moves to another folder. Set by the sidebar (`setAutoDir`).
   */
  autoDir = $state<string | null>(null);
  /** The auto-opened folder the user folded by hand: it stays folded until focus leaves it. Not kept. */
  private shut = $state<string | null>(null);
  /**
   * Folders that were auto-opened while the pointer was on the list: they stay open until it leaves, so the row just
   * clicked does not slide away under the cursor when a folder above it folds.
   */
  linger = $state<string[]>([]);
  private holding = false;

  isDirFolded(key: string): boolean {
    if (this.openDirs.includes(key)) return false;
    if (key === this.autoDir) return this.shut === key;
    return !this.linger.includes(key);
  }

  /** Opening keeps the folder open (`openDirs`); folding also folds it while it is the auto-opened one. */
  toggleDir(key: string) {
    if (this.isDirFolded(key)) {
      this.openDirs = [...this.openDirs.filter((p) => p !== key), key];
      if (this.shut === key) this.shut = null;
    } else {
      this.openDirs = this.openDirs.filter((p) => p !== key);
      if (key === this.autoDir) this.shut = key;
      if (this.linger.includes(key)) this.linger = this.linger.filter((p) => p !== key);
    }
    write(K.openDirs, this.openDirs);
  }

  /** Focus moved to folder `key`: open it, and fold the one before unless the pointer is still on the list (`hold`). */
  setAutoDir(key: string | null) {
    if (key === this.autoDir) return;
    const prev = this.autoDir;
    const keep = this.holding && prev !== null && prev !== this.shut && !this.linger.includes(prev);
    const linger = keep ? [...this.linger, prev] : this.holding ? this.linger : [];
    this.linger = key === null ? linger : linger.filter((p) => p !== key);
    this.autoDir = key;
    this.shut = null;
  }

  /** The pointer is on the sidebar's list (true) or left it (false: the lingering folders fold now). */
  hold(on: boolean) {
    this.holding = on;
    if (!on && this.linger.length) this.linger = [];
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
