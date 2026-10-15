/**
 * Shared behaviour for every modal surface, so each dialog does not hand-roll its own:
 *  - a stack of open modals: Esc closes only the top one (a picker over the settings window leaves the window open);
 *  - Tab cycles inside the top modal instead of escaping to the page behind it;
 *  - keys typed inside a modal never reach the app's global shortcuts (switch / delete session…);
 *  - focus moves into the modal on open and returns to whatever opened it on close.
 *
 * `modalLayer` is for `role="dialog"` panels (components/Modal.svelte uses it); `nativeModal` is the same for a
 * component whose root is a native `<dialog>` that lives as long as the component.
 *
 * Listeners go through `on()` from svelte/events: it runs the delegated `onkeydown` handlers of the children first,
 * so stopping propagation here does not silence them (a plain addEventListener + stopPropagation would).
 */
import { on } from "svelte/events";

export interface LayerOpts {
	onclose?: () => void;
	/** false while closing must not happen (saving, a download in progress); Esc is still swallowed */
	dismissible?: boolean;
	/**
	 * What had focus before the modal opened. Pass it when it is captured early (component init): by the time this
	 * action runs, a child may already have focused itself (autofocus), and that is not where focus should return.
	 */
	opener?: HTMLElement | null;
}

type Layer = { node: HTMLElement; opts: LayerOpts };
const stack: Layer[] = [];
type Back = { opts: { onclose?: () => void; dismissible?: boolean }; entry: boolean };
const backs: Back[] = [];

/*
 * Back button / back swipe (mobile): every open modal owns one history entry, so "back" closes the top modal instead of
 * leaving the page. When a modal is closed by other means (scrim, ✕, Esc) its entry is dropped with history.back(); the
 * popstate that causes is ignored (`skip`).
 */
let skip = 0;

function pushEntry(layer: Back) {
	history.pushState({ ...(history.state ?? {}), modalLayer: true }, "");
	layer.entry = true;
}

function dropEntry(layer: Back) {
	if (!layer.entry) return;
	layer.entry = false;
	skip++;
	history.back();
}

function onPop() {
	if (skip > 0) {
		skip--;
		return;
	}
	let layer: Back | undefined;
	for (let i = backs.length - 1; i >= 0; i--) {
		if (backs[i]!.entry) {
			layer = backs[i];
			break;
		}
	}
	if (!layer) return;
	layer.entry = false; // the browser already took it
	if (layer.opts.dismissible !== false) layer.opts.onclose?.();
	// Still open afterwards (not dismissible, or onclose only stepped back inside it): it needs an entry for the next press.
	setTimeout(() => {
		if (backs.includes(layer) && !layer.entry) pushEntry(layer);
	}, 0);
}

function track(layer: Back) {
	if (!backs.length) window.addEventListener("popstate", onPop);
	backs.push(layer);
	pushEntry(layer);
}

function untrack(layer: Back) {
	const i = backs.indexOf(layer);
	if (i >= 0) backs.splice(i, 1);
	dropEntry(layer);
	if (!backs.length) window.removeEventListener("popstate", onPop);
}

const FOCUSABLE =
	'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]"));
}

/** Keep Tab / Shift+Tab inside `root`. Returns true when it moved focus. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
	if (e.key !== "Tab" || e.defaultPrevented) return false; // a field used Tab itself (e.g. path completion)
	const list = focusables(root);
	if (!list.length) {
		e.preventDefault();
		root.focus();
		return true;
	}
	const first = list[0]!;
	const last = list[list.length - 1]!;
	const at = document.activeElement;
	const outside = !at || !root.contains(at) || at === root;
	if (e.shiftKey && (at === first || outside)) {
		e.preventDefault();
		last.focus();
		return true;
	}
	if (!e.shiftKey && (at === last || outside)) {
		e.preventDefault();
		first.focus();
		return true;
	}
	return false;
}

export function topLayer(): HTMLElement | null {
	return stack[stack.length - 1]?.node ?? null;
}

/** Esc for the top modal. Runs after the focused element's own handlers, so a field or menu that used Esc keeps it. */
function escapeLayer(e: KeyboardEvent, layer: Layer) {
	if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
	e.preventDefault();
	if (layer.opts.dismissible !== false) layer.opts.onclose?.();
}

/** Focus was on <body> (a click on plain text inside the modal): the key never passed through a panel. */
function onWindowKey(e: KeyboardEvent) {
	const top = stack[stack.length - 1];
	if (!top) return;
	const target = e.target instanceof Node ? e.target : null;
	if (target && stack.some((l) => l.node.contains(target))) return;
	if (e.key === "Tab") return void trapTab(e, top.node);
	escapeLayer(e, top);
}

export function modalLayer(node: HTMLElement, opts: LayerOpts) {
	const layer: Layer = { node, opts };
	const hist: Back = { opts, entry: false };
	const current = document.activeElement instanceof HTMLElement && !node.contains(document.activeElement) ? document.activeElement : null;
	const opener = opts.opener !== undefined ? opts.opener : current;
	if (!stack.length) window.addEventListener("keydown", onWindowKey);
	stack.push(layer);
	track(hist);
	if (!node.hasAttribute("tabindex")) node.tabIndex = -1;

	const onKey = (e: KeyboardEvent) => {
		// A modal underneath (not portalled) only sees keys that bubbled out of the one on top: leave them alone.
		if (stack[stack.length - 1] === layer) {
			if (!trapTab(e, node)) escapeLayer(e, layer);
		}
		e.stopPropagation(); // the app's shortcuts stay quiet while a modal has the keyboard
	};
	const offKey = on(node, "keydown", onKey);

	// Children focus themselves first (search fields, the default button); otherwise take focus so keys land here.
	// The panel itself rather than its first field: on a phone that would pop the keyboard over the sheet.
	// A child that focused itself while mounting (a search field, the default button) runs before this action, so it is
	// the active element right now. A portal then moves the panel to <body>, which blurs it: give focus back to it
	// rather than taking it for the panel.
	const wanted = node.contains(document.activeElement) && document.activeElement !== node ? (document.activeElement as HTMLElement) : null;
	queueMicrotask(() => {
		if (!node.isConnected || node.contains(document.activeElement) && document.activeElement !== node) return;
		if (wanted?.isConnected && node.contains(wanted)) wanted.focus({ preventScroll: true });
		else if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
	});

	return {
		update(next: LayerOpts) {
			layer.opts = next;
			hist.opts = next;
		},
		destroy() {
			offKey();
			const i = stack.indexOf(layer);
			if (i >= 0) stack.splice(i, 1);
			untrack(hist);
			if (!stack.length) window.removeEventListener("keydown", onWindowKey);
			const top = topLayer();
			const back = opener?.isConnected && (!top || top.contains(opener)) ? opener : top;
			if (back && (document.activeElement === document.body || node.contains(document.activeElement))) back.focus({ preventScroll: true });
		},
	};
}

/**
 * A component-lifetime native `<dialog>`: opens modally on mount, closes and gives focus back on destroy, dismisses on a
 * press that both starts and ends on the backdrop (a text selection dragged outside is not a dismissal), keeps Tab
 * inside, and keeps the app's shortcuts quiet. Esc arrives as the dialog's own `cancel` event (`oncancel`).
 */
export function nativeModal(dialog: HTMLDialogElement, opts: { onclose: () => void }) {
	let current = opts;
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	dialog.showModal();
	const back: Back = { opts: { onclose: () => current.onclose() }, entry: false };
	track(back);

	const outside = (e: MouseEvent) => {
		if (e.target !== dialog) return false;
		const r = dialog.getBoundingClientRect();
		return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
	};
	let downOutside = false;
	const onDown = (e: MouseEvent) => (downOutside = outside(e));
	const onClick = (e: MouseEvent) => {
		const dismiss = downOutside && outside(e);
		downOutside = false;
		if (dismiss) current.onclose();
	};
	const onKey = (e: KeyboardEvent) => {
		e.stopPropagation();
		trapTab(e, dialog);
	};
	const offs = [on(dialog, "mousedown", onDown), on(dialog, "click", onClick), on(dialog, "keydown", onKey)];

	return {
		update(next: { onclose: () => void }) {
			current = next;
		},
		destroy() {
			for (const off of offs) off();
			untrack(back);
			dialog.close();
			if (opener?.isConnected) opener.focus();
		},
	};
}

/** Lift a node to <body>: a modal opened from inside a transformed panel would otherwise be positioned relative to it. */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return { destroy: () => node.remove() };
}
