/** Footer (the line under the input) settings: which items show, in what order, and how the line behaves when it is full. Free of runes so tests can import it. */

/** Items a user can show, hide and reorder. Extension statuses are not listed: they always come first. */
export const FOOTER_ITEMS = ["context", "cache", "speed", "elapsed", "agents", "skills", "mcp", "roles", "commands"] as const;
export type FooterItemId = (typeof FOOTER_ITEMS)[number];

/** auto: wraps on a wide pane, one scrolling row on a narrow one · wrap: always wraps · scroll: always one scrolling row */
export const FOOTER_LAYOUTS = ["auto", "wrap", "scroll"] as const;
export type FooterLayout = (typeof FOOTER_LAYOUTS)[number];
export const FOOTER_ALIGNS = ["center", "start"] as const;
export type FooterAlign = (typeof FOOTER_ALIGNS)[number];

export interface FooterPrefs {
  order: FooterItemId[];
  hidden: FooterItemId[];
  layout: FooterLayout;
  align: FooterAlign;
}

export const DEFAULT_FOOTER: FooterPrefs = { order: [...FOOTER_ITEMS], hidden: [], layout: "auto", align: "center" };

const isItem = (v: unknown): v is FooterItemId => typeof v === "string" && (FOOTER_ITEMS as readonly string[]).includes(v);

/** Keep valid fields of a stored value. The order keeps what it lists (no duplicates) and appends items it does not know yet, so an app update that adds an item still shows it. */
export function sanitizeFooter(raw: unknown): FooterPrefs {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const listed = Array.isArray(r.order) ? r.order.filter(isItem) : [];
  const order = [...new Set(listed)];
  for (const id of FOOTER_ITEMS) if (!order.includes(id)) order.push(id);
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter(isItem))] : [];
  return {
    order,
    hidden,
    layout: (FOOTER_LAYOUTS as readonly unknown[]).includes(r.layout) ? (r.layout as FooterLayout) : DEFAULT_FOOTER.layout,
    align: (FOOTER_ALIGNS as readonly unknown[]).includes(r.align) ? (r.align as FooterAlign) : DEFAULT_FOOTER.align,
  };
}

/** Move `id` one place up (-1) or down (+1); the ends stay put. */
export function moveFooterItem(order: FooterItemId[], id: FooterItemId, dir: -1 | 1): FooterItemId[] {
  const from = order.indexOf(id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The items to draw, in order, without the hidden ones. */
export function visibleFooter(p: FooterPrefs): FooterItemId[] {
  return p.order.filter((id) => !p.hidden.includes(id));
}
