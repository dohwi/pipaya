/**
 * One app-wide context menu for places without a menu of their own (the rail, a pane's title bar, the phone's pane strip).
 * `App.svelte` mounts a `RowMenu` and registers it here; the sidebar and the tab bar keep their own, which highlight the row.
 */
import type { IconName } from "../components/Icon.svelte";
import type { Point } from "./press-menu";

export interface MenuItem {
	icon: IconName;
	label: string;
	title: string;
	run: () => void;
}
interface Host {
	openAt(pt: Point, id: string, items: MenuItem[]): void;
	close(): void;
}

let host: Host | undefined;
export const registerContextMenu = (h: Host | undefined) => void (host = h);
export const openContextMenu = (pt: Point, id: string, items: MenuItem[]) => host?.openAt(pt, id, items);
export const closeContextMenu = () => host?.close();
