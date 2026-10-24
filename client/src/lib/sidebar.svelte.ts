/**
 * The sidebar's own state: drawer open (phone), collapsed and width (desktop), which tree nodes are folded, and the
 * order the user dragged folders and tabs into (per server). Persisted on this device.
 */
import { K, read, write } from "./persist";

export const SIDEBAR_W = { min: 220, max: 560, def: 288 };
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(SIDEBAR_W.max, Math.max(SIDEBAR_W.min, Math.round(n))) : SIDEBAR_W.def);

/** Put `key` before/after `target` within `visible` (the entries as listed now). Null when nothing changes. */
export function reorder(visible: string[], key: string, target: string, after: boolean): string[] | null {
  if (key === target) return null;
  const list = visible.filter((p) => p !== key);
  const at = list.indexOf(target);
  if (at < 0) return null;
  list.splice(at + (after ? 1 : 0), 0, key);
  return list;
}

export class SidebarState {
  /** The drawer on a narrow screen. */
  open = $state(false);
  collapsed = $state(read<boolean>(K.sidebar, false));
  width = $state(clamp(read<number>(K.sidebarW, SIDEBAR_W.def)));
  folded = $state<string[]>(read<string[]>(K.folded, []));
  dirOrder = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.dirOrder, {}));
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

  /** Put directory `path` before/after `target` within `visible` (the directories as listed now) and remember it. */
  moveDir(serverId: string, visible: string[], path: string, target: string, after: boolean) {
    const list = reorder(visible, path, target, after);
    if (!list) return;
    this.dirOrder = { ...this.dirOrder, [serverId]: list };
    write(K.dirOrder, this.dirOrder);
  }

  /** Put tab `id` before/after `target` among the tabs of one directory (`visible`, as listed now) and remember it. */
  moveTab(serverId: string, visible: string[], id: string, target: string, after: boolean) {
    const list = reorder(visible, id, target, after);
    if (!list) return;
    const rest = (this.tabOrder[serverId] ?? []).filter((x) => !list.includes(x));
    this.tabOrder = { ...this.tabOrder, [serverId]: [...rest, ...list] };
    write(K.tabOrder, this.tabOrder);
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
    }
    const d = this.dirOrder[serverId] ?? [];
    const newDirs = dirs.filter((p) => !d.includes(p));
    if (newDirs.length) {
      this.dirOrder = { ...this.dirOrder, [serverId]: [...d, ...newDirs] };
      write(K.dirOrder, this.dirOrder);
    }
    const t = this.tabOrder[serverId] ?? [];
    const newTabs = tabs.filter((x) => !t.includes(x));
    if (newTabs.length) {
      this.tabOrder = { ...this.tabOrder, [serverId]: [...t, ...newTabs] };
      write(K.tabOrder, this.tabOrder);
    }
  }

  /** Remember `list` (the tabs of one directory, in order) as placed by hand. */
  placeTabs(serverId: string, list: string[]) {
    const rest = (this.tabOrder[serverId] ?? []).filter((x) => !list.includes(x));
    this.tabOrder = { ...this.tabOrder, [serverId]: [...rest, ...list] };
    write(K.tabOrder, this.tabOrder);
  }
}

