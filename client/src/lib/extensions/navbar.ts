import { parseView, uiParse, UI_ID_PATTERN, type UINode } from "./ui";
import { LocalizedError, t } from "../i18n";

/**
 * Generic, non-interactive header items. The host knows nothing about what an item shows:
 * it validates a restricted data-only view and hands it to the trusted renderer.
 */
export interface NavbarItemSpec { label: string; view: UINode }
export interface NavbarItem extends NavbarItemSpec { owner: string; id: string }

export const NAVBAR_LIMITS = Object.freeze({
  items: 3,
  label: 40,
  nodes: 60,
  depth: 4,
  viewBytes: 32 * 1024,
});

/** Only passive display nodes; buttons, forms, inputs, tabs, tables, lists, code and alerts are rejected. */
export const NAVBAR_NODE_TYPES = Object.freeze([
  "stack", "grid", "text", "badge", "divider", "progress", "stat", "icon",
] as const);

export function navbarId(input: unknown): string {
  if (typeof input !== "string" || !UI_ID_PATTERN.test(input)) throw new LocalizedError(t("ID는 소문자·숫자·하이픈만 사용할 수 있습니다 (최대 40자)"));
  return input;
}

export function parseNavbarItem(input: unknown): NavbarItemSpec {
  const source = uiParse.object(input, "navbar", ["label", "view"]);
  const label = uiParse.text(uiParse.required(source, "navbar", "label"), "navbar.label", NAVBAR_LIMITS.label);
  const view = parseView(uiParse.required(source, "navbar", "view"), {
    maxNodes: NAVBAR_LIMITS.nodes,
    maxDepth: NAVBAR_LIMITS.depth,
    maxBytes: NAVBAR_LIMITS.viewBytes,
    allowed: NAVBAR_NODE_TYPES,
  });
  return { label, view };
}
