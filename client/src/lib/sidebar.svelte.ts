/**
 * The sidebar's own state: drawer open (phone), collapsed and width (desktop), which tree nodes are folded, and the
 * order the user dragged folders and tabs into (per server). Persisted on this device.
 */
import { clampTo } from "./number";
import { K, read, write } from "./persist";

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
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

export class SidebarState {
  /** Told after the user edits a server's shared part, so it can be uploaded. */
  onEdit: (serverId: string) => void = () => {};

  /** The drawer on a narrow screen. */
  open = $state(false);
  collapsed = $state(read<boolean>(K.sidebar, false));
  width = $state(clamp(read<number>(K.sidebarW, SIDEBAR_W.def)));
  folded = $state<string[]>(read<string[]>(K.folded, []));
  dirOrder = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.dirOrder, {}));
  /** Folders pinned per server: they stay listed with no tabs in them. */
  pinned = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.pinnedDirs, {}));
  /** Names given to pinned folders per server, shown in place of the path's tail (the path still sits beside it). Dropped on unpin. */
  dirNames = $state<Record<string, Record<string, string>>>(read<Record<string, Record<string, string>>>(K.dirNames, {}));
  /** Tabs pinned per server: they sit at the top of their folder, in their own order. A split tab is pinned as a whole. */
  pinnedTabs = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.pinnedTabs, {}));
  /** Order of the tabs (group / session / terminal ids) set by dragging, per server; ranks tabs within their directory. */
  tabOrder = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.tabOrder, {}));

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
   * Unfold the one node that holds `key` (a folder's `dirKey`, or a server's id), so the row it stands for can be seen
   * when something opens in it. Nothing else in the tree moves: the rest stays as the user folded it.
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
    const empty = !o.pinnedDirs.length && !o.pinnedTabs.length && !o.dirOrder.length && !o.tabOrder.length && !Object.keys(o.dirNames).length && !Object.keys(o.groupDir).length;
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
    write(K.pinnedDirs, this.pinned);
    write(K.pinnedTabs, this.pinnedTabs);
    write(K.dirOrder, this.dirOrder);
    write(K.tabOrder, this.tabOrder);
    write(K.dirNames, this.dirNames);
    write(K.groupDir, this.groupDir);
  }
}
