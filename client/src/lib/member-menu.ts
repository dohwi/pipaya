import { rowMenuEntries } from "./sidebar-model";
import type { MenuItem } from "./context-menu";
import { chooseGroup } from "./group-picker";
import { app } from "./store.svelte";

/**
 * The menu of one pane of a split tab outside the sidebar (a session chip, a pane's title bar): the sidebar's own entries for
 * a `member` (`rowMenuEntries`), so every place a pane is listed offers the same things in the same order. Dissolving the whole
 * group and archiving are left out: those belong to the sidebar's menus. `extra` entries come right after renaming.
 */
export function memberMenu(id: string, title: string, rename: (id: string, title: string) => void, extra: MenuItem[] = []): MenuItem[] {
	const target = app.terminal(id) ? ({ kind: "terminal", x: { id, title } } as const) : ({ kind: "session", x: { id, title } } as const);
	const entries = rowMenuEntries(
		target,
		{
			renameTab: rename,
			renameGroup: () => {},
			groupWith: chooseGroup,
			closeSession: (sid) => void app.close(sid),
			closeTerminal: (sid) => void app.closeTerminal(sid),
			leaveGroup: (sid) => void app.leaveGroup(sid),
		},
		true,
	);
	// "group with another conversation" is the sidebar's drag-less way to group; a pane is already in a group
	const rest = entries.filter((e) => e.icon !== "columns");
	const at = rest.findIndex((e) => e.icon === "pencil") + 1;
	return [...rest.slice(0, at), ...extra, ...rest.slice(at)];
}
