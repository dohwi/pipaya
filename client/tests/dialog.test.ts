import { afterEach, describe, expect, test } from "bun:test";
import { backLayer, handleBack, trapTab } from "../src/lib/dialog";

/** Just enough DOM for the Tab trap: focusable children with a layout box, and a document focus pointer. */
type Fake = { name: string; focus: () => void; getClientRects: () => unknown[]; closest: () => null };
const g = globalThis as unknown as { document?: { activeElement: unknown } };
const prevDoc = g.document;
afterEach(() => {
	g.document = prevDoc;
});

function setup(names: string[]) {
	g.document = { activeElement: null };
	const doc = g.document;
	const items: Fake[] = names.map((name) => ({ name, focus: () => (doc.activeElement = items.find((i) => i.name === name)), getClientRects: () => [1], closest: () => null }));
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
		expect(handleBack()).toBe(false);
	});

	test("closes only the top layer", () => {
		fakeBrowser();
		const closed: string[] = [];
		const drawer = backLayer({ onclose: () => closed.push("drawer") });
		const modal = backLayer({ onclose: () => closed.push("modal") });
		expect(handleBack()).toBe(true);
		expect(closed).toEqual(["modal"]);
		modal(); // the modal unmounts after closing
		expect(handleBack()).toBe(true);
		expect(closed).toEqual(["modal", "drawer"]);
		drawer();
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
