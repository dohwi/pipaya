import { MAX_PANES, has as layoutHas, panesOf, remove as layoutRemove, worthKeeping } from "../layout";
import { sessionOrder, tabOf, tabPanes, type DirBlock } from "../nav";
import type { TerminalInfo } from "../terminal";
import type { Group, Session } from "../types";

/**
 * True when another pane can join `group` (either `group` is undefined, `sessionId` is already inside it, or the
 * pane count is strictly below `MAX_PANES`).
 */
export function canAddToGroup(group: Group | undefined, sessionId?: string): boolean {
  if (!group) return true;
  if (sessionId && layoutHas(group.layout, sessionId)) return true;
  return panesOf(group.layout).length < MAX_PANES;
}

/**
 * Take `id` out of its group, dissolving the group when fewer than two panes remain. Returns the updated groups
 * array (or null when `id` was not in any group).
 */
export function stripSessionFromGroups(groups: readonly Group[], id: string): Group[] | null {
  const index = groups.findIndex((g) => layoutHas(g.layout, id));
  if (index < 0) return null;
  const target = groups[index]!;
  const next = layoutRemove(target.layout, id);
  if (worthKeeping(next)) {
    const updated = groups.slice();
    updated[index] = { ...target, layout: next };
    return updated;
  }
  return groups.filter((x) => x.id !== target.id);
}

export interface NeighbourContext {
  id: string;
  group: Group | undefined;
  dirs: readonly DirBlock[];
  lastPane: Readonly<Record<string, string>>;
  sessions: readonly Session[];
  groups: readonly Group[];
  terminals: readonly TerminalInfo[];
  dirOrder: readonly string[];
  tabOrder: readonly string[];
  pinnedTabs: readonly string[];
  shows: (id: string) => boolean;
}

/**
 * Choose which session/terminal should take focus when `id` leaves:
 * 1) next or previous pane inside the same group
 * 2) next or previous tab inside the same folder
 * 3) next or previous entry in overall sidebar order
 */
export function findSessionNeighbour(ctx: NeighbourContext): string | undefined {
  const { id, group, dirs, lastPane, shows } = ctx;
  if (group) {
    const ids = panesOf(group.layout).filter((x) => shows(x));
    const i = ids.indexOf(id);
    const inGroup = i < 0 ? undefined : (ids[i + 1] ?? ids[i - 1]);
    if (inGroup) return inGroup;
  }
  const at = tabOf(dirs as DirBlock[], id);
  if (at) {
    const i = at.dir.tabs.findIndex((x) => x.id === at.tab.id);
    const sib = at.dir.tabs[i + 1] ?? at.dir.tabs[i - 1];
    const last = sib ? lastPane[sib.id] : undefined;
    const pane = sib && (last && shows(last) ? last : tabPanes(sib)[0]);
    if (pane) return pane;
  }
  const order = sessionOrder(
    ctx.sessions,
    ctx.groups,
    ctx.dirOrder,
    ctx.tabOrder,
    ctx.terminals,
    ctx.pinnedTabs,
  );
  const i = order.indexOf(id);
  return i < 0 ? undefined : (order[i + 1] ?? order[i - 1]);
}
