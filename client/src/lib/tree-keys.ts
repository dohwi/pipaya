/**
 * Arrow keys on the sidebar tree, as in a file manager's tree (WAI-ARIA tree pattern, without changing the markup):
 *
 * - Up / Down move focus to the row above / below (a header's main button, or a tab row's open button).
 * - Right on a folded header unfolds it; on an open one moves to its first child row.
 * - Left on an open header folds it; on a row inside a block (or a folded header) moves to the header above it.
 *
 * Folding goes through the header's own chevron button (`[aria-expanded]`), so the state, persistence and animation
 * are the same as a click. Rename fields and menus keep their keys.
 */

/** A row's header: server, project, folder (branch) or split tab. Its chevron is the `[aria-expanded]` button inside. */
export const HEAD = ".srvhead, .proj, .dir, .grprow";
/** The button that stands for a row when it takes focus */
const MAIN = ".srvtoggle, .projtoggle, .dirtoggle, .open";
/** Every row the arrows walk, in document order */
const ROWS = `:is(${HEAD}, .item)`;

/** The focusable main button of a row (its name), else its chevron */
export function mainOf(row: Element): HTMLElement | null {
	return row.querySelector<HTMLElement>(`:scope > :is(${MAIN}), :scope > * > :is(${MAIN})`) ?? row.querySelector<HTMLElement>("[aria-expanded]");
}

/** The fold button of a header row (null: not a header, or a header that cannot fold) */
export function foldOf(row: Element): HTMLButtonElement | null {
	if (!row.matches(HEAD)) return null;
	const b = row.querySelector<HTMLButtonElement>(":scope > button[aria-expanded], :scope > * > button[aria-expanded]");
	return b && !b.disabled ? b : null;
}

/** What a key does on `row`, given the rows on screen in order. Pure, so it can be tested without a DOM layout. */
export type TreeMove = { kind: "focus"; to: number } | { kind: "toggle" } | null;
export function treeMove(key: string, index: number, count: number, opts: { header: boolean; open: boolean; foldable: boolean; parent: number; firstChild: number }): TreeMove {
	if (index < 0) return null;
	if (key === "ArrowDown") return index + 1 < count ? { kind: "focus", to: index + 1 } : null;
	if (key === "ArrowUp") return index > 0 ? { kind: "focus", to: index - 1 } : null;
	if (key === "Home") return count ? { kind: "focus", to: 0 } : null;
	if (key === "End") return count ? { kind: "focus", to: count - 1 } : null;
	if (key === "ArrowRight") {
		if (!opts.header || !opts.foldable) return null;
		if (!opts.open) return { kind: "toggle" };
		return opts.firstChild >= 0 ? { kind: "focus", to: opts.firstChild } : null;
	}
	if (key === "ArrowLeft") {
		if (opts.header && opts.foldable && opts.open) return { kind: "toggle" };
		return opts.parent >= 0 ? { kind: "focus", to: opts.parent } : null;
	}
	return null;
}

/** The block a header row opens and folds: its children live in the `.fold` sibling of the header (or of its block). */
function blockOf(row: Element): Element | null {
	return row.closest(".dirblock, .projblock, .grp, .srv");
}

export function treeKeys(node: HTMLElement) {
	const onKey = (e: KeyboardEvent) => {
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
		const target = e.target as HTMLElement;
		if (target.closest("input, textarea, [contenteditable], [role=menu]")) return;
		const rows = Array.from(node.querySelectorAll<HTMLElement>(ROWS)).filter((r) => r.offsetParent !== null && !r.closest(".skeleton-in"));
		const row = target.closest<HTMLElement>(ROWS);
		const index = row ? rows.indexOf(row) : -1;
		if (!row || index < 0) return;
		const header = row.matches(HEAD);
		const fold = foldOf(row);
		const open = fold?.getAttribute("aria-expanded") === "true";
		const block = header ? blockOf(row) : null;
		const firstChild = header && block ? rows.findIndex((r, i) => i > index && block.contains(r)) : -1;
		// the header of the closest block around this row (for a header: the block around its own block)
		const around = (header ? blockOf(row)?.parentElement : row)?.closest(".dirblock, .projblock, .grp, .srv");
		const parentRow = around ? rows.find((r) => r.matches(HEAD) && blockOf(r) === around) : undefined;
		const parent = parentRow && parentRow !== row ? rows.indexOf(parentRow) : -1;
		const move = treeMove(e.key, index, rows.length, { header, open, foldable: !!fold, parent, firstChild });
		if (!move) return;
		e.preventDefault();
		if (move.kind === "toggle") {
			fold!.click();
			return;
		}
		const to = rows[move.to];
		to && mainOf(to)?.focus();
	};
	node.addEventListener("keydown", onKey);
	return { destroy: () => node.removeEventListener("keydown", onKey) };
}
