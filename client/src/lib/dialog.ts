/**
 * Shared behaviour for every modal surface, so each dialog does not hand-roll its own:
 *  - a stack of open modals: Esc closes only the top one (a picker over the settings window leaves the window open);
 *  - Tab cycles inside the top modal instead of escaping to the page behind it;
 *  - keys typed inside a modal never reach the app's global shortcuts (switch / delete session…);
 *  - focus moves into the modal on open and returns to whatever opened it on close.
 *
 * `modalLayer` is for `role="dialog"` panels (components/ui/Modal.svelte uses it).
 *
 * The opener is matched in capture, before a focused list can consume it as navigation. Other keys go through
 * `on()` from svelte/events so the delegated `onkeydown` handlers of the children still run first.
 */
import { on } from "svelte/events";
import { emptyRecording, isBareCombo, isModifierCode, recordKey, recordingCombo, tabComboYieldsFocus, type Recording } from "./keys";

export interface LayerOpts {
	/** Only this binding may dismiss the layer; never dispatch an action to the page behind it. */
	closeBinding?: string;
	onshortcutclose?: () => void;
	onclose?: () => void;
	/** false while closing must not happen (saving, a download in progress); Esc is still swallowed */
	dismissible?: boolean;
	/**
	 * What had focus before the modal opened. Pass it when it is captured early (component init): by the time this
	 * action runs, a child may already have focused itself (autofocus), and that is not where focus should return.
	 */
	opener?: HTMLElement | null;
}

type Layer = { node: HTMLElement; opts: LayerOpts; prefix?: Recording };
const stack: Layer[] = [];
const modalListeners = new Set<(count: number) => void>();
function notifyModalStack() {
	const count = stack.length;
	for (const fn of [...modalListeners]) fn(count);
}
type Back = { opts: { onclose?: () => void; dismissible?: boolean }; entry: boolean };
const backs: Back[] = [];

/*
 * Back button / back swipe (mobile): every open modal owns one history entry, so "back" closes the top modal instead of
 * leaving the page.
 *
 * `sync()` is the only place that touches the history: it makes the number of entries we pushed (`pushed`) equal the
 * number of layers that own one. Removing entries is one `history.go(-n)` (several `history.back()` calls in the same
 * tick are coalesced by browsers and leave stray entries), and while that traversal is in flight nothing is pushed
 * (a push in between would be the entry the traversal removes). The popstate it causes is ours (`pending`), not the
 * user's.
 */
let pushed = 0;
let pending = 0;
let listening = false;

function sync() {
	if (pending) return; // the popstate of our own traversal re-runs this
	const want = backs.filter((b) => b.entry).length;
	while (pushed < want) {
		history.pushState({ ...(history.state ?? {}), modalLayer: true }, "");
		pushed++;
	}
	if (pushed > want) {
		pending = pushed - want;
		history.go(-pending);
	}
}

function onPop() {
	if (pending) {
		pushed = Math.max(0, pushed - pending);
		pending = 0;
		sync();
		return;
	}
	// The user went back: the browser took one of our entries.
	if (pushed > 0) pushed--;
	let layer: Back | undefined;
	for (let i = backs.length - 1; i >= 0; i--) {
		if (backs[i]!.entry) {
			layer = backs[i];
			break;
		}
	}
	if (!layer) return;
	layer.entry = false;
	if (layer.opts.dismissible !== false) layer.opts.onclose?.();
	// Still open afterwards (not dismissible, or onclose only stepped back inside it): it needs an entry for the next press.
	setTimeout(() => {
		if (backs.includes(layer) && !layer.entry) {
			layer.entry = true;
			sync();
		}
	}, 0);
	sync();
}

function track(layer: Back) {
	if (!listening) {
		listening = true;
		window.addEventListener("popstate", onPop);
	}
	backs.push(layer);
	layer.entry = true;
	sync();
}

function untrack(layer: Back) {
	const i = backs.indexOf(layer);
	if (i >= 0) backs.splice(i, 1);
	layer.entry = false;
	sync();
}

/** A non-modal surface (the phone sidebar drawer) that the back button should close. Returns the release function. */
export function backLayer(opts: { onclose: () => void; dismissible?: boolean }): () => void {
	const layer: Back = { opts, entry: false };
	track(layer);
	return () => untrack(layer);
}

/**
 * The native back button (Tauri Android does not turn it into a popstate once it is handled natively):
 * closes the top open modal / drawer. Returns false when there is nothing to close.
 */
export function handleBack(): boolean {
	const top = backs[backs.length - 1];
	if (!top) return false;
	if (top.opts.dismissible !== false) top.opts.onclose?.();
	return true;
}

const FOCUSABLE =
	'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
	// tabIndex < 0: a control the keyboard reaches some other way (a card's X): Tab skips it, so the trap must too, or the
	// wrap waits on an element Tab never lands on and focus slips out of the modal first
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest("[inert]"));
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

/** How many modal layers are currently open (Modal, Palette, Lightbox). */
export function modalCount(): number {
	return stack.length;
}

/** Subscribe to modal stack depth changes; returns the unsubscribe function. */
export function onModalStackChange(fn: (count: number) => void): () => void {
	modalListeners.add(fn);
	return () => {
		modalListeners.delete(fn);
	};
}

/** Esc for the top modal. Runs after the focused element's own handlers, so a field or menu that used Esc keeps it. */
function escapeLayer(e: KeyboardEvent, layer: Layer) {
	if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
	e.preventDefault();
	if (layer.opts.dismissible !== false) layer.opts.onclose?.();
}

/** Match the opener locally, including ordered chords, without arming any other app shortcut. */
export function toggleLayer(e: KeyboardEvent, layer: Layer) {
	const binding = layer.opts.closeBinding;
	const composing = (e.isComposing || e.keyCode === 229) && !(e.ctrlKey || e.metaKey);
	if (!binding || e.defaultPrevented || composing || e.getModifierState?.("AltGraph")) {
		layer.prefix = undefined;
		return;
	}
	if (isModifierCode(e.code)) return;
	if (e.key === "Escape") {
		if (layer.prefix) e.preventDefault(); // first Esc cancels an unfinished chord
		layer.prefix = undefined;
		return;
	}
	const target = e.target as HTMLElement | null;
	const typing = target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "");
	const next = recordKey(layer.prefix ?? emptyRecording(), e).next;
	const combo = recordingCombo(next);
	if (!layer.prefix && ((typing && isBareCombo(combo)) || tabComboYieldsFocus(combo, target))) return;
	if (binding === combo || binding.startsWith(`${combo}+`)) {
		e.preventDefault();
		if (e.repeat) return;
		if (binding !== combo) { layer.prefix = next; return; }
		layer.prefix = undefined;
		if (layer.opts.dismissible !== false) (layer.opts.onshortcutclose ?? layer.opts.onclose)?.();
	} else if (!e.repeat) layer.prefix = undefined;
}

function resetModalChord() {
	for (const layer of stack) layer.prefix = undefined;
}

/** Focus was on <body> (a click on plain text inside the modal): the key never passed through a panel. */
function onWindowKey(e: KeyboardEvent) {
	const top = stack[stack.length - 1];
	if (!top) return;
	const target = e.target instanceof Node ? e.target : null;
	if (target && stack.some((l) => l.node.contains(target))) return;
	toggleLayer(e, top);
	if (e.key === "Tab") return void trapTab(e, top.node);
	escapeLayer(e, top);
}

export function modalLayer(node: HTMLElement, opts: LayerOpts) {
	const layer: Layer = { node, opts };
	const hist: Back = { opts, entry: false };
	const current = document.activeElement instanceof HTMLElement && !node.contains(document.activeElement) ? document.activeElement : null;
	const opener = opts.opener !== undefined ? opts.opener : current;
	resetModalChord();
	if (!stack.length) {
		window.addEventListener("keydown", onWindowKey);
		window.addEventListener("blur", resetModalChord);
		window.addEventListener("pointerdown", resetModalChord, true);
	}
	stack.push(layer);
	notifyModalStack();
	track(hist);
	if (!node.hasAttribute("tabindex")) node.tabIndex = -1;

	const onCapture = (e: KeyboardEvent) => {
		if (stack[stack.length - 1] !== layer || e.defaultPrevented) return;
		toggleLayer(e, layer);
		if (e.defaultPrevented) e.stopPropagation(); // only the configured opener or a step of its chord
	};
	node.addEventListener("keydown", onCapture, true);
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
			node.removeEventListener("keydown", onCapture, true);
			offKey();
			const i = stack.indexOf(layer);
			if (i >= 0) {
				stack.splice(i, 1);
				notifyModalStack();
			}
			untrack(hist);
			if (!stack.length) {
				window.removeEventListener("keydown", onWindowKey);
				window.removeEventListener("blur", resetModalChord);
				window.removeEventListener("pointerdown", resetModalChord, true);
			}
			const top = topLayer();
			const back = opener?.isConnected && (!top || top.contains(opener)) ? opener : top;
			if (back && (document.activeElement === document.body || node.contains(document.activeElement))) back.focus({ preventScroll: true });
		},
	};
}

/** The event `recentreModal` sends; components/ui/Modal.svelte listens for it on its panel. */
export const RECENTRE = "pipaya:modal-recentre";

/**
 * Ask the modal around `node` to centre itself again at its current size. A modal keeps its top edge while its content
 * grows (an expanding row must not drift), so a body that swaps to a different page (a list replaced by its form) calls
 * this once the new page is in the DOM; otherwise the taller page stays pinned to the window's bottom edge.
 */
export function recentreModal(node: HTMLElement) {
	node.dispatchEvent(new CustomEvent(RECENTRE, { bubbles: true }));
}

/**
 * `use:recentreOn={page}`: centre the enclosing modal again whenever `page` changes (a list swapped for its form, a
 * step, a tab). Waits one animation frame so the new page is laid out; that frame runs before the next paint, so the
 * panel is never drawn at the old place. Outside a modal (the same pane inside the settings window) it does nothing.
 */
export function recentreOn(node: HTMLElement, page: unknown) {
	let raf = 0;
	return {
		update(next: unknown) {
			if (Object.is(next, page)) return;
			page = next;
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => node.isConnected && recentreModal(node));
		},
		destroy: () => cancelAnimationFrame(raf),
	};
}

/** `use:recentreOnMount`: the same for a page that replaces another inside a modal that stays open (an import's result). */
export function recentreOnMount(node: HTMLElement) {
	const raf = requestAnimationFrame(() => node.isConnected && recentreModal(node));
	return { destroy: () => cancelAnimationFrame(raf) };
}

/** Lift a node to <body>: a modal opened from inside a transformed panel would otherwise be positioned relative to it. */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return { destroy: () => node.remove() };
}
