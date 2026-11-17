import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { tapTogglesActions } from "../src/lib/reveal";

const doc = new Window().document;
const el = (html: string) => {
	const box = doc.createElement("div");
	box.innerHTML = html;
	return box.querySelector("[data-hit]") as unknown as Element;
};

describe("tapTogglesActions", () => {
	test("a tap on the message's text toggles its buttons", () => {
		expect(tapTogglesActions(el('<p data-hit>hello</p>'), "")).toBe(true);
	});
	test("a tap on the message's own controls does not", () => {
		for (const html of ['<a href="#"><span data-hit>x</span></a>', '<button><i data-hit></i></button>', '<pre><code data-hit>x</code></pre>', '<div role="button" data-hit>x</div>'])
			expect(tapTogglesActions(el(html), ""), html).toBe(false);
	});
	test("a tap that ends a text selection does not", () => {
		expect(tapTogglesActions(el('<p data-hit>hello</p>'), "hello")).toBe(false);
		expect(tapTogglesActions(el('<p data-hit>hello</p>'), "  ")).toBe(true);
	});
	test("nothing to tap on: no", () => {
		expect(tapTogglesActions(null, "")).toBe(false);
	});
});
