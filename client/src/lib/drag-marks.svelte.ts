/** Where a carried thing would land relative to a row or block: its id and which side. */
export interface Slot {
	id: string;
	after: boolean;
}

/** Where a carried block (folder or server) would land: before/after a target block, or merged onto it. */
export type BlockPlace = "before" | "after" | "over";

export interface BlockDrop {
	id: string;
	place: BlockPlace;
}

/**
 * What the sidebar draws while something is being dragged: which row is pulled onto (`over`), the line where a tab
 * would land among its siblings (`tab`), and the block being carried with where it would land (`block`).
 * The template used to compare these three-to-five fields by hand on every row; it now asks `over / tabLine /
 * blockMark`. A `.svelte.ts` module: the fields are runes, so a template reading them updates.
 */
export class DragMarks {
	/** The row a dragged tab is hovering over: dropping joins it (group / pair) */
	dropOn = $state<string | null>(null);
	/** The tab row a carried tab would land before / after */
	tab = $state<Slot | null>(null);
	/** The block (`dir:path`, `server:id`) being carried, and where it would land (`dir:…`, `project:…`, `server:…`) */
	carried = $state<string | null>(null);
	block = $state<BlockDrop | null>(null);

	/** `hover(key)` target: the highlight follows the pointer and clears only if it is still this row's */
	hover(key: string, inside: boolean) {
		if (inside) this.dropOn = key;
		else if (this.dropOn === key) this.dropOn = null;
	}

	over = (key: string) => this.dropOn === key;

	/** A tab row's drop line: `before` / `after` / none */
	tabLine(id: string): "before" | "after" | null {
		return this.tab?.id === id ? (this.tab.after ? "after" : "before") : null;
	}

	/** Set the tab line to row `id` (a reorder edge) or clear it if it was this row's */
	setTab(id: string, edge: "before" | "after" | null) {
		if (edge) this.tab = { id, after: edge === "after" };
		else if (this.tab?.id === id) this.tab = null;
	}

	/** A block's state: carried (faded), a reorder line before/after it, or highlighted to merge (`over`). The carried block itself never shows a drop target mark. */
	blockMark(key: string): { carried: boolean; before: boolean; after: boolean; over: boolean } {
		const mine = this.block?.id === key && this.carried !== key;
		return {
			carried: this.carried === key,
			before: mine && this.block!.place === "before",
			after: mine && this.block!.place === "after",
			over: mine && this.block!.place === "over",
		};
	}

	/** The block-drag host's `set`: carrying `drag` (or nothing), landing at `drop` */
	setBlock(drag: string | null, drop: BlockDrop | null) {
		this.carried = drag;
		this.block = drop;
	}
}
