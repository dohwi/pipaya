import { msg, t } from "./i18n";
import { MAX_PANES, measure, pane, panesOf, type Layout, type Rect } from "./layout";
import type { PaletteSpec } from "./store-model";

export type LayoutPresetId = "columns" | "rows" | "grid" | "grid-tall" | "main-left" | "main-top";

export interface LayoutPreset {
	id: LayoutPresetId;
	label: string;
	desc: string;
	recommended: boolean;
	layout: Layout;
	/** Normalised pane rectangles (0..1) for preview thumbnails. */
	boxes: Rect[];
}

/**
 * Balanced binary split chain along `dir` ("row": side by side, "col": stacked).
 * Every item gets an exact `1 / items.length` share, every split ratio stays within [1/3, 2/3],
 * and tree depth stays <= ceil(log2(MAX_PANES)) = 3 (well under server MAX_DEPTH = 8).
 */
function chain(items: Layout[], dir: "row" | "col"): Layout {
	if (items.length === 1) return items[0]!;
	const mid = Math.floor(items.length / 2);
	return {
		type: "split",
		dir,
		ratio: mid / items.length,
		a: chain(items.slice(0, mid), dir),
		b: chain(items.slice(mid), dir),
	};
}

/** Arrange `ids` into rows of at most `cols` panes, top to bottom. */
function gridLayout(ids: readonly string[], cols: number): Layout {
	const rows: Layout[] = [];
	for (let i = 0; i < ids.length; i += cols) {
		rows.push(chain(ids.slice(i, i + cols).map(pane), "row"));
	}
	return chain(rows, "col");
}

/** First pane on the left half; remaining panes stacked vertically (2–3) or in a 2-column grid (4+). */
function mainLeftLayout(ids: readonly string[]): Layout {
	const [first, ...rest] = ids;
	const secondary = rest.length <= 3 ? chain(rest.map(pane), "col") : gridLayout(rest, 2);
	return { type: "split", dir: "row", ratio: 0.5, a: pane(first!), b: secondary };
}

/** First pane on the top half; remaining panes side by side underneath. */
function mainTopLayout(ids: readonly string[]): Layout {
	const [first, ...rest] = ids;
	return { type: "split", dir: "col", ratio: 0.5, a: pane(first!), b: chain(rest.map(pane), "row") };
}

function makePreset(id: LayoutPresetId, label: string, desc: string, layout: Layout, recommended = false): LayoutPreset {
	return {
		id,
		label,
		desc,
		recommended,
		layout,
		boxes: measure(layout).panes.map(({ x, y, w, h }) => ({ x, y, w, h })),
	};
}

/** Verify all session ids are non-empty and distinct so a preset never silently drops panes. */
function validIds(ids: readonly string[]): string[] | null {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (!id || seen.has(id)) return null;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * Available layout presets for `ids` (2..MAX_PANES panes).
 * Index 0 is always the recommended default for that pane count (e.g. 3-column split for 3 panes, 2×2 grid for 4).
 */
export function presetsFor(rawIds: readonly string[]): LayoutPreset[] {
	const ids = validIds(rawIds);
	if (!ids) return [];
	const n = ids.length;
	if (n < 2 || n > MAX_PANES) return [];

	const columns = (recommended = false) =>
		makePreset("columns", t("좌우 {n}분할", { n }), t("창 {n}개를 가로로 균등 배치", { n }), chain(ids.map(pane), "row"), recommended);
	const rows = (recommended = false) =>
		makePreset("rows", t("상하 {n}분할", { n }), t("창 {n}개를 세로로 균등 배치", { n }), chain(ids.map(pane), "col"), recommended);
	const evenGrid = (id: "grid" | "grid-tall", cols: number, rowCount: number, recommended = false) =>
		makePreset(id, t("{cols}×{rows} 격자", { cols, rows: rowCount }), t("창 {n}개를 {cols}열 {rows}행으로 균등 배치", { n, cols, rows: rowCount }), gridLayout(ids, cols), recommended);
	const splitGrid = (top: number, bottom: number, recommended = false) =>
		makePreset("grid", t("격자 ({top} + {bottom})", { top, bottom }), t("위 {top}칸 · 아래 {bottom}칸으로 균등 배치", { top, bottom }), gridLayout(ids, top), recommended);
	const mainLeft = () => {
		const rest = n - 1;
		const desc = rest <= 3 ? t("왼쪽 큰 창 1개 · 오른쪽 {rest}개 세로 배치", { rest }) : t("왼쪽 큰 창 1개 · 오른쪽 {rest}개 격자 배치", { rest });
		return makePreset("main-left", t("왼쪽 메인 (1 + {rest})", { rest }), desc, mainLeftLayout(ids));
	};
	const mainTop = () => {
		const rest = n - 1;
		return makePreset("main-top", t("위쪽 메인 (1 / {rest})", { rest }), t("위쪽 큰 창 1개 · 아래쪽 {rest}개 가로 배치", { rest }), mainTopLayout(ids));
	};

	switch (n) {
		case 2:
			return [columns(true), rows()];
		case 3:
			return [columns(true), mainLeft(), mainTop(), rows()];
		case 4:
			return [evenGrid("grid", 2, 2, true), columns(), mainLeft(), rows()];
		case 5:
			return [splitGrid(3, 2, true), mainLeft(), columns(), rows()];
		case 6:
			return [evenGrid("grid", 3, 2, true), evenGrid("grid-tall", 2, 3), mainLeft(), columns()];
		case 7:
			return [splitGrid(4, 3, true), mainLeft(), columns()];
		case 8:
			return [evenGrid("grid", 4, 2, true), evenGrid("grid-tall", 2, 4), mainLeft(), columns()];
		default:
			return [];
	}
}

const MATCH_EPS = 0.015;

/** Whether two layouts place every pane in geometrically the same rectangle (independent of tree nesting). */
export function layoutsMatch(a: Layout, b: Layout, eps = MATCH_EPS): boolean {
	const pa = measure(a).panes;
	const pb = measure(b).panes;
	if (pa.length !== pb.length) return false;
	const byId = new Map(pb.map((p) => [p.id, p]));
	for (const x of pa) {
		const y = byId.get(x.id);
		if (!y) return false;
		if (Math.abs(x.x - y.x) > eps || Math.abs(x.y - y.y) > eps || Math.abs(x.w - y.w) > eps || Math.abs(x.h - y.h) > eps) return false;
	}
	return true;
}

/** The preset that geometrically matches `layout`, or null if custom/irregular. */
export function matchPreset(layout: Layout): LayoutPreset | null {
	const presets = presetsFor(panesOf(layout));
	return presets.find((p) => layoutsMatch(layout, p.layout)) ?? null;
}

/** The recommended preset for `layout`'s current pane count. */
export function recommendedPreset(layout: Layout): LayoutPreset | null {
	return presetsFor(panesOf(layout))[0] ?? null;
}

/** Look up a specific preset for `layout` by id. */
export function findPreset(layout: Layout, id: LayoutPresetId): LayoutPreset | null {
	return presetsFor(panesOf(layout)).find((p) => p.id === id) ?? null;
}

/** Build the layout selection palette spec for a split group. */
export function layoutPaletteSpec(
	group: { name: string; layout: Layout },
	onSelect: (presetId: LayoutPresetId) => void | Promise<void>,
): PaletteSpec {
	const presets = presetsFor(panesOf(group.layout));
	const active = matchPreset(group.layout);
	return {
		closeShortcut: "arrangePanes",
		title: t("'{name}' 레이아웃 선택", { name: group.name }),
		empty: msg("적용할 레이아웃이 없습니다"),
		items: presets.map((p) => ({
			id: p.id,
			title: p.label,
			sub: p.desc,
			tag: p.recommended ? t("추천") : undefined,
			current: active?.id === p.id,
			preview: p.boxes,
		})),
		onpick: (it) => {
			const chosen = presets.find((p) => p.id === it.id);
			if (chosen) return onSelect(chosen.id);
		},
	};
}
