import { layoutPaletteSpec } from "./layout-presets";
import { app } from "./store.svelte";

/**
 * Open the layout preset picker for a split group.
 * Presets match the group's current pane count, with the recommended arrangement tagged and listed first.
 */
export function chooseGroupLayout(groupId: string, serverId?: string | null) {
	const g = app.groupById(groupId, serverId);
	if (!g) return;
	app.palette = layoutPaletteSpec(g, (presetId) => void app.arrangeGroup(g.id, presetId, serverId));
}
