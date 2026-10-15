/**
 * The sidebar's own state: drawer open (phone), collapsed and width (desktop), which tree nodes are folded, and the
 * order the user dragged folders and groups into (per server). Persisted on this device.
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
  groupOrder = $state<Record<string, string[]>>(read<Record<string, string[]>>(K.groupOrder, {}));

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

  /** Same for groups, by id. */
  moveGroup(serverId: string, visible: string[], id: string, target: string, after: boolean) {
    const list = reorder(visible, id, target, after);
    if (!list) return;
    this.groupOrder = { ...this.groupOrder, [serverId]: list };
    write(K.groupOrder, this.groupOrder);
  }
}
