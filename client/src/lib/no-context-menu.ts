/**
 * Suppress the browser/WebView's native right-click menu (Print, Save as, View source, Inspect, Back/Reload …).
 * Editable fields keep it so cut/copy/paste by mouse still works; touch screens keep it so the selection toolbar appears. Components with their own menus can still listen
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

/** On touch screens a long-press raises `contextmenu` together with the text-selection toolbar (Copy, Select all …); cancelling it kills that toolbar. */
function touchPrimary(): boolean {
	return window.matchMedia("(pointer: coarse)").matches;
}

export function installNoContextMenu(): void {
	window.addEventListener("contextmenu", (e) => {
		if (touchPrimary()) return;
		if (!isEditable(e.target)) e.preventDefault();
	});
}
