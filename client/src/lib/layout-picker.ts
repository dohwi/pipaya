import { msg, t } from "./i18n";
import { panesOf } from "./layout";
import { matchPreset, presetsFor, type LayoutPresetId } from "./layout-presets";
import { app } from "./store.svelte";

/**
 * Open the layout preset picker for a split group.
 * Presets match the group's current pane count, with the recommended arrangement tagged and listed first.
 */
export function chooseGroupLayout(groupId: string, serverId?: string | null) {
	const g = app.groupById(groupId, serverId);
	if (!g) return;
	const presets = presetsFor(panesOf(g.layout));
	const active = matchPreset(g.layout);
	app.palette = {
		closeShortcut: "chooseLayout",
		title: t("'{name}' 레이아웃 선택", { name: g.name }),
		empty: msg("적용할 레이아웃이 없습니다"),
		items: presets.map((p) => ({
			id: p.id,
			title: p.label,
			sub: p.desc,
			tag: p.recommended ? t("추천") : undefined,
			current: active?.id === p.id,
			preview: p.boxes,
		})),
		onpick: (it) => void app.arrangeGroup(g.id, it.id as LayoutPresetId, serverId),
	};
}
