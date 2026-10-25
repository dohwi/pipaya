import { MAX_PANES, MAX_RATIO, MIN_RATIO, type Layout } from "../layout";
import { LocalizedError, t } from "../i18n";

const fail = (m: string): never => { throw new LocalizedError(m); };

/** What an extension passes as a layout; `id` and `sessionId` both name the pane (a session or terminal id). */
export type LayoutSpec =
  | { type: "pane"; id?: string; sessionId?: string }
  | { type: "split"; dir: "row" | "col"; ratio?: number; a: LayoutSpec; b: LayoutSpec };

/** Validate an extension's layout tree into a fresh copy: panes are ids, splits row/col with a ratio in 0.1–0.9, at most 8 panes. */
export function parseLayout(input: unknown): Layout {
  const seen = new Set<string>();
  const walk = (n: unknown, depth: number): Layout => {
    if (depth > 8) fail(t("레이아웃이 너무 깊습니다"));
    if (!n || typeof n !== "object" || Array.isArray(n)) return fail(t("레이아웃 노드는 객체여야 합니다"));
    const o = n as Record<string, unknown>;
    if (o.type === "pane") {
      const id = o.sessionId ?? o.id;
      if (typeof id !== "string" || !id || id.length > 80) return fail(t("pane에는 id가 필요합니다"));
      if (seen.has(id)) fail(t("같은 패널이 두 번 들어 있습니다: {id}", { id }));
      seen.add(id);
      if (seen.size > MAX_PANES) fail(t("그룹에는 대화를 최대 {n}개까지 넣을 수 있습니다", { n: MAX_PANES }));
      return { type: "pane", sessionId: id };
    }
    if (o.type === "split") {
      if (o.dir !== "row" && o.dir !== "col") fail(t("split의 dir은 row 또는 col이어야 합니다"));
      const ratio = o.ratio === undefined ? 0.5 : o.ratio;
      if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) fail(t("비율은 0.1~0.9여야 합니다"));
      return { type: "split", dir: o.dir as "row" | "col", ratio: ratio as number, a: walk(o.a, depth + 1), b: walk(o.b, depth + 1) };
    }
    return fail(t("레이아웃 노드는 pane 또는 split이어야 합니다"));
  };
  const layout = walk(input, 1);
  if (seen.size < 2) fail(t("그룹에는 패널이 두 개 이상 필요합니다"));
  return layout;
}
