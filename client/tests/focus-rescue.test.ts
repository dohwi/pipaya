import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installFocusRescue } from "../src/lib/focus-rescue";

/** happy-dom has no layout: an element holds focus while it is in the page and not inside [inert] or [hidden]. */
const holds = (el: Element | null | undefined): el is HTMLElement => !!el && el.isConnected && !el.closest("[inert], [hidden]");

function setup(enabled = true) {
	const win = new Window();
	const doc = win.document as unknown as Document;
	doc.body.innerHTML = `<textarea id="composer"></textarea><nav><button id="more">⋯</button></nav><div id="menu"><button id="item">rename</button></div>`;
	(doc as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
	const $ = (id: string) => doc.getElementById(id) as HTMLElement;
	const off = installFocusRescue(doc, () => $("composer"), () => enabled, holds);
	/** Take `id` out of the page while it holds focus. happy-dom sends no focusout then; a browser does (target: the focused element, no relatedTarget). */
	const remove = (id: string) => {
		const focused = doc.activeElement as HTMLElement;
		// sent while still in the page (a detached node's event never reaches the document), looked at a frame later
		focused.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: null }) as unknown as Event);
		$(id).remove();
	};
	const frame = () => new Promise((r) => win.requestAnimationFrame(() => r(null)));
	return { doc, $, off, remove, frame: async () => (await frame(), await frame()) };
}

describe("focus rescue", () => {
	test("a removed menu item gives focus back to the button the menu was opened from", async () => {
		const { doc, $, remove, frame } = setup();
		$("more").focus();
		$("item").focus();
		remove("menu");
		await frame();
		expect(doc.activeElement?.id).toBe("more");
	});
	test("with nothing before it that can hold focus, the pane's input takes it", async () => {
		const { doc, $, remove, frame } = setup();
		$("item").focus();
		remove("menu");
		await frame();
		expect(doc.activeElement?.id).toBe("composer");
	});
	test("an element hidden (inert) while focused counts as lost too", async () => {
		const { doc, $, frame } = setup();
		$("composer").focus();
		$("more").focus();
		doc.querySelector("nav")!.setAttribute("inert", "");
		$("more").blur();
		await frame();
		expect(doc.activeElement?.id).toBe("composer");
	});
	test("a blur the user made (the element is still there) is left alone", async () => {
		const { doc, $, frame } = setup();
		$("composer").focus();
		$("more").focus();
		$("more").blur();
		await frame();
		expect(doc.activeElement).toBe(doc.body);
	});
	test("focus moving straight to something else is not touched", async () => {
		const { doc, $, frame } = setup();
		$("item").focus();
		$("more").focus();
		await frame();
		expect(doc.activeElement?.id).toBe("more");
	});
	test("off on touch, and after uninstalling", async () => {
		const touch = setup(false);
		touch.$("item").focus();
		touch.remove("menu");
		await touch.frame();
		expect(touch.doc.activeElement).toBe(touch.doc.body);
		const gone = setup();
		gone.off();
		gone.$("item").focus();
		gone.remove("menu");
		await gone.frame();
		expect(gone.doc.activeElement).toBe(gone.doc.body);
	});
});
