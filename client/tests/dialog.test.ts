import { afterEach, describe, expect, test } from "bun:test";
import { backLayer, handleBack, hasBackLayer, modalCount, modalLayer, onModalStackChange, toggleLayer, trapTab, type LayerOpts } from "../src/lib/dialog";
import { isMac } from "../src/lib/keys";
import { configureUiEnv } from "../src/lib/ui-env.svelte";

/** Just enough DOM for the Tab trap: focusable children with a layout box, and a document focus pointer. */
type Fake = { name: string; tabIndex: number; focus: () => void; getClientRects: () => unknown[]; closest: () => null };
const g = globalThis as unknown as { document?: { activeElement: unknown } };
const prevDoc = g.document;
afterEach(() => {
	g.document = prevDoc;
});

function setup(names: string[], skipped: string[] = []) {
	g.document = { activeElement: null };
	const doc = g.document;
	const items: Fake[] = names.map((name) => ({ name, tabIndex: skipped.includes(name) ? -1 : 0, focus: () => (doc.activeElement = items.find((i) => i.name === name)), getClientRects: () => [1], closest: () => null }));
	const root = {
		querySelectorAll: () => items,
		contains: (n: unknown) => items.includes(n as Fake),
		focus: () => (doc.activeElement = root),
	};
	const key = (shiftKey = false) => {
		let prevented = false;
		return { key: "Tab", shiftKey, defaultPrevented: false, preventDefault: () => (prevented = true), get prevented() { return prevented; } };
	};
	return { doc, items, root: root as unknown as HTMLElement, key };
}

describe("trapTab", () => {
	test("Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last", () => {
		const { doc, items, root, key } = setup(["a", "b", "c"]);
		doc.activeElement = items[2];
		const e = key();
		expect(trapTab(e as unknown as KeyboardEvent, root)).toBe(true);
		expect(e.prevented).toBe(true);
		expect(doc.activeElement).toBe(items[0]);

		const back = key(true);
		trapTab(back as unknown as KeyboardEvent, root);
		expect(doc.activeElement).toBe(items[2]);
	});

	test("in the middle the browser moves focus as usual", () => {
		const { doc, items, root, key } = setup(["a", "b", "c"]);
		doc.activeElement = items[1];
		const e = key();
		expect(trapTab(e as unknown as KeyboardEvent, root)).toBe(false);
		expect(e.prevented).toBe(false);
	});

	test("focus outside the modal (on the panel itself or the page) is pulled back in", () => {
		const { doc, items, root, key } = setup(["a", "b"]);
		doc.activeElement = root;
		trapTab(key() as unknown as KeyboardEvent, root);
		expect(doc.activeElement).toBe(items[0]);
	});

	test("a field that used Tab itself (path completion) keeps it", () => {
		const { doc, items, root, key } = setup(["a", "b"]);
		doc.activeElement = items[1];
		const e = { ...key(), defaultPrevented: true };
		expect(trapTab(e as unknown as KeyboardEvent, root)).toBe(false);
		expect(doc.activeElement).toBe(items[1]);
	});

	test("a control Tab skips (tabindex -1) is not an end: Tab on the last real stop still wraps", () => {
		const { doc, items, root, key } = setup(["a", "b", "x"], ["x"]);
		doc.activeElement = items[1];
		const e = key();
		expect(trapTab(e as unknown as KeyboardEvent, root)).toBe(true);
		expect(doc.activeElement).toBe(items[0]);
	});

	test("other keys are ignored", () => {
		const { root } = setup(["a"]);
		expect(trapTab({ key: "Enter" } as KeyboardEvent, root)).toBe(false);
	});
});

describe("handleBack (native back button)", () => {
	const w = globalThis as unknown as { window?: unknown; history?: unknown };
	const prev = { window: w.window, history: w.history };
	afterEach(() => {
		w.window = prev.window;
		w.history = prev.history;
	});
	function fakeBrowser() {
		w.window = { addEventListener: () => {} };
		w.history = { state: null, pushState: () => {}, go: () => {} };
	}

	test("nothing open: returns false, so the app may exit", () => {
		fakeBrowser();
		expect(hasBackLayer()).toBe(false);
		expect(handleBack()).toBe(false);
	});

	test("closes only the top layer", () => {
		fakeBrowser();
		const closed: string[] = [];
		const drawer = backLayer({ onclose: () => closed.push("drawer") });
		expect(hasBackLayer()).toBe(true);
		const modal = backLayer({ onclose: () => closed.push("modal") });
		expect(handleBack()).toBe(true);
		expect(closed).toEqual(["modal"]);
		modal(); // the modal unmounts after closing
		expect(handleBack()).toBe(true);
		expect(closed).toEqual(["modal", "drawer"]);
		drawer();
		expect(hasBackLayer()).toBe(false);
		expect(handleBack()).toBe(false);
	});

	test("a layer that cannot be dismissed swallows the press without closing or exiting", () => {
		fakeBrowser();
		let closed = 0;
		const release = backLayer({ onclose: () => closed++, dismissible: false });
		expect(handleBack()).toBe(true);
		expect(closed).toBe(0);
		release();
	});
});

describe("toggleLayer", () => {
	function keyEvent(overrides: Partial<KeyboardEvent> & { code: string; key: string }) {
		let prevented = false;
		const e = {
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			shiftKey: false,
			repeat: false,
			defaultPrevented: false,
			isComposing: false,
			keyCode: 0,
			target: null,
			getModifierState: () => false,
			preventDefault: () => { prevented = true; },
			...overrides,
		};
		return { e: e as unknown as KeyboardEvent, get prevented() { return prevented; } };
	}

	function layer(opts: LayerOpts) {
		return { node: {} as HTMLElement, opts };
	}

	test("runs onshortcutclose instead of onclose when closeBinding matches", () => {
		let closed = 0;
		let shortcutClosed = 0;
		const l = layer({
			closeBinding: "Mod+D",
			onclose: () => closed++,
			onshortcutclose: () => shortcutClosed++,
		});
		const k = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
		toggleLayer(k.e, l);
		expect(k.prevented).toBe(true);
		expect(shortcutClosed).toBe(1);
		expect(closed).toBe(0);
	});

	test("falls back to onclose when onshortcutclose is omitted", () => {
		let closed = 0;
		const l = layer({ closeBinding: "Mod+D", onclose: () => closed++ });
		const k = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
		toggleLayer(k.e, l);
		expect(k.prevented).toBe(true);
		expect(closed).toBe(1);
	});

	test("still triggers Mod+D while IME is composing (Korean syllable right before shortcut)", () => {
		let shortcutClosed = 0;
		const l = layer({ closeBinding: "Mod+D", onshortcutclose: () => shortcutClosed++ });
		const k = keyEvent({ code: "KeyD", key: "Process", ctrlKey: true, isComposing: true, keyCode: 229 });
		toggleLayer(k.e, l);
		expect(k.prevented).toBe(true);
		expect(shortcutClosed).toBe(1);
	});

	test("ignores bare key while IME is composing", () => {
		let closed = 0;
		const l = layer({ closeBinding: "D", onclose: () => closed++ });
		const k = keyEvent({ code: "KeyD", key: "Process", isComposing: true, keyCode: 229 });
		toggleLayer(k.e, l);
		expect(k.prevented).toBe(false);
		expect(closed).toBe(0);
	});

	test("ignores repeat, empty binding, and non-dismissible layer", () => {
		let closed = 0;
		const l = layer({ closeBinding: "Mod+D", onshortcutclose: () => closed++ });
		const rep = keyEvent({ code: "KeyD", key: "d", ctrlKey: true, repeat: true });
		toggleLayer(rep.e, l);
		expect(rep.prevented).toBe(true);
		expect(closed).toBe(0);

		const empty = layer({ closeBinding: "", onshortcutclose: () => closed++ });
		const k2 = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
		toggleLayer(k2.e, empty);
		expect(k2.prevented).toBe(false);
		expect(closed).toBe(0);

		const locked = layer({ closeBinding: "Mod+D", dismissible: false, onshortcutclose: () => closed++ });
		const k3 = keyEvent({ code: "KeyD", key: "d", ctrlKey: true });
		toggleLayer(k3.e, locked);
		expect(k3.prevented).toBe(true);
		expect(closed).toBe(0);
	});

	test("yields Mod+Arrow closeBinding only in a non-empty input when nativeInputKeys is enabled, never on a chord second key", () => {
		let closed = 0;
		const mod = isMac ? { metaKey: true } : { ctrlKey: true };
		const filledInput = { tagName: "INPUT", type: "text", value: "abc" } as unknown as EventTarget;
		const emptyInput = { tagName: "INPUT", type: "text", value: "" } as unknown as EventTarget;
		const l = layer({ closeBinding: "Mod+ArrowLeft", onclose: () => closed++ });
		try {
			configureUiEnv({ nativeInputKeys: () => true });
			// Non-empty input: yields to native cursor jump
			const k1 = keyEvent({ code: "ArrowLeft", key: "ArrowLeft", ...mod, target: filledInput });
			toggleLayer(k1.e, l);
			expect(k1.prevented).toBe(false);
			expect(closed).toBe(0);
			// Empty input: closes the modal
			const k2 = keyEvent({ code: "ArrowLeft", key: "ArrowLeft", ...mod, target: emptyInput });
			toggleLayer(k2.e, l);
			expect(k2.prevented).toBe(true);
			expect(closed).toBe(1);
			// Toggle off: closes even in a non-empty input
			configureUiEnv({ nativeInputKeys: () => false });
			const k3 = keyEvent({ code: "ArrowLeft", key: "ArrowLeft", ...mod, target: filledInput });
			toggleLayer(k3.e, l);
			expect(k3.prevented).toBe(true);
			expect(closed).toBe(2);
			// Armed chord second key never yields even when nativeInputKeys is on
			configureUiEnv({ nativeInputKeys: () => true });
			const chord = layer({ closeBinding: "Mod+B+ArrowLeft", onclose: () => closed++ });
			const c1 = keyEvent({ code: "KeyB", key: "b", ...mod, target: filledInput });
			toggleLayer(c1.e, chord);
			expect(c1.prevented).toBe(true);
			const c2 = keyEvent({ code: "ArrowLeft", key: "ArrowLeft", ...mod, target: filledInput });
			toggleLayer(c2.e, chord);
			expect(c2.prevented).toBe(true);
			expect(closed).toBe(3);
		} finally {
			configureUiEnv({ nativeInputKeys: () => true });
		}
	});
});

describe("modalCount and onModalStackChange", () => {
	const g = globalThis as unknown as {
		window?: unknown;
		document?: unknown;
		history?: unknown;
		HTMLElement?: unknown;
	};
	const prev = { window: g.window, document: g.document, history: g.history, HTMLElement: g.HTMLElement };
	afterEach(() => {
		g.window = prev.window;
		g.document = prev.document;
		g.history = prev.history;
		g.HTMLElement = prev.HTMLElement;
	});

	function fakeNode() {
		return {
			tabIndex: -1,
			isConnected: true,
			hasAttribute: () => true,
			addEventListener: () => {},
			removeEventListener: () => {},
			contains: () => false,
			focus: () => {},
		} as unknown as HTMLElement;
	}

	function setupEnv() {
		g.HTMLElement = class {};
		g.window = { addEventListener: () => {}, removeEventListener: () => {} };
		g.document = { activeElement: null, body: {} };
		g.history = { state: null, pushState: () => {}, go: () => {} };
	}

	test("tracks nested modal stack depth and supports unsubscribing during notifications", async () => {
		setupEnv();
		expect(modalCount()).toBe(0);
		const seen: number[] = [];
		const offA = onModalStackChange((n) => seen.push(n));
		let bCalls = 0;
		let offB = () => {};
		offB = onModalStackChange(() => {
			bCalls++;
			offB();
		});

		const m1 = modalLayer(fakeNode(), {});
		const m2 = modalLayer(fakeNode(), {});
		expect(modalCount()).toBe(2);
		m2.destroy();
		expect(modalCount()).toBe(1);
		m1.destroy();
		// destroying twice does not emit duplicate notifications or underflow
		m1.destroy();
		expect(modalCount()).toBe(0);
		expect(seen).toEqual([1, 2, 1, 0]);
		expect(bCalls).toBe(1);

		offA();
		offA(); // double unsubscribe is safe
		const m3 = modalLayer(fakeNode(), {});
		m3.destroy();
		expect(seen).toEqual([1, 2, 1, 0]);
		await Promise.resolve();
	});
});
