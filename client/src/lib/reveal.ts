/** Whether a tap on `target` inside a message should show or hide its buttons. */
export function tapTogglesActions(target: EventTarget | null, selected: string): boolean {
	if (selected.trim()) return false;
	// duck-typed: a tap's target is an Element (or a text node's parent), and tests hand in another window's elements
	const el = target as { closest?: (sel: string) => unknown } | null;
	if (!el || typeof el.closest !== "function") return false;
	return !el.closest("a, button, input, textarea, select, summary, label, video, audio, pre, [contenteditable='true'], [role='button']");
}
