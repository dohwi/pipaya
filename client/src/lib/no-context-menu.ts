/**
 * Suppress the browser/WebView's native right-click menu (Print, Save as, View source, Inspect, Back/Reload …).
 * Editable fields keep it so cut/copy/paste by mouse still works. Components with their own menus can still listen
 * for `contextmenu` themselves; this only cancels the default action.
 */
export function isEditable(target: EventTarget | null): boolean {
	const el = target instanceof Element ? target : null;
	if (!el) return false;
	if (el.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) {
		const input = el.closest("input");
		return !input || !["button", "checkbox", "radio", "range", "submit", "reset", "image", "file", "color"].includes(input.type);
	}
	return false;
}

export function installNoContextMenu(): void {
	window.addEventListener("contextmenu", (e) => {
		if (!isEditable(e.target)) e.preventDefault();
	});
}
