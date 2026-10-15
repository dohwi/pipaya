/**
 * Arrow-key navigation for a row of tabs / radios (WAI-ARIA roving focus with automatic activation):
 *
 *   <div role="tablist" use:rovingKeys={{ item: '[role="tab"]' }}>
 *
 * Left/Right (and Home/End) move focus to the neighbouring enabled item and click it, wrapping at the ends.
 * Pair it with `tabindex={selected ? 0 : -1}` on the items so Tab enters and leaves the group in one stop.
 */
export function nextIndex(key: string, index: number, count: number): number | null {
	if (count <= 0 || index < 0) return null;
	if (key === "ArrowRight") return (index + 1) % count;
	if (key === "ArrowLeft") return (index - 1 + count) % count;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return null;
}

/** Which arrows move: left/right (a row), up/down (a column), or both (a list that turns into a row on a phone). */
export type RovingAxis = "x" | "y" | "both";

/** Fold the arrows of the chosen axis into Right/Left, which `nextIndex` understands. */
export function axisKey(key: string, axis: RovingAxis): string {
	if (axis !== "x") {
		if (key === "ArrowDown") return "ArrowRight";
		if (key === "ArrowUp") return "ArrowLeft";
	}
	if (axis === "y" && (key === "ArrowRight" || key === "ArrowLeft")) return "";
	return key;
}

export function rovingKeys(node: HTMLElement, options: { item: string; axis?: RovingAxis }) {
	let { item, axis = "x" } = options;
	const onKey = (e: KeyboardEvent) => {
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const items = Array.from(node.querySelectorAll<HTMLElement>(item)).filter((el) => !(el as HTMLButtonElement).disabled);
		const next = nextIndex(axisKey(e.key, axis), items.indexOf(node.ownerDocument.activeElement as HTMLElement), items.length);
		if (next == null) return;
		e.preventDefault();
		items[next].focus();
		items[next].click();
	};
	node.addEventListener("keydown", onKey);
	return {
		update(o: { item: string; axis?: RovingAxis }) {
			item = o.item;
			axis = o.axis ?? "x";
		},
		destroy: () => node.removeEventListener("keydown", onKey),
	};
}
