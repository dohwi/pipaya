import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { hoverScope } from "../src/lib/hover-scope";

const TARGETS = ".srvhead, .dir, .proj, .item, .grprow, .dirnew, .more, .gfold, .navbtn";

function setup() {
	const win = new Window();
	const doc = win.document as unknown as Document;
	doc.body.innerHTML = `
		<div class="side" id="wrap">
			<div class="full">
				<aside class="side" id="aside">
					<div class="list" id="list">
						<div class="dir" id="dir1">
							<button class="dirnew listbtn" id="list1"></button>
							<button class="dirnew" id="plus1"></button>
						</div>
						<div class="dir" id="dir2">
							<button class="dirnew" id="plus2"></button>
						</div>
					</div>
				</aside>
			</div>
		</div>
		<main id="main"><div id="chat"></div></main>
	`;
	const $ = (id: string) => doc.getElementById(id) as HTMLElement;
	const aside = $("aside");
	aside.getBoundingClientRect = () => ({ left: 0, top: 0, right: 288, bottom: 900, width: 288, height: 900, x: 0, y: 0, toJSON: () => ({}) });

	let hitEl: Element | null = null;
	(doc as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => hitEl;
	const setHit = (el: Element | null) => {
		hitEl = el;
	};

	const action = hoverScope(aside, TARGETS);
	const pointer = (type: string, target: EventTarget, opts: { pointerType?: string; clientX?: number; clientY?: number } = {}) => {
		const ev = new win.Event(type, { bubbles: true }) as unknown as PointerEvent;
		Object.defineProperties(ev, {
			pointerType: { value: opts.pointerType ?? "mouse" },
			clientX: { value: opts.clientX ?? 250 },
			clientY: { value: opts.clientY ?? 100 },
		});
		target.dispatchEvent(ev);
	};
	const frame = () => new Promise((r) => win.requestAnimationFrame(() => r(null)));
	const hoveredIds = () => [...doc.querySelectorAll("[data-hovered]")].map((e) => e.id);
	return { win, doc, $, aside, action, pointer, setHit, hoveredIds, frame: async () => (await frame(), await frame()) };
}

describe("hoverScope", () => {
	test("marks matching ancestor chain on mouse move and clears immediately on moving into main", () => {
		const { $, pointer, hoveredIds } = setup();
		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);

		pointer("pointermove", $("chat"), { clientX: 600, clientY: 300 });
		expect(hoveredIds()).toEqual([]);
	});

	test("touch and pen input never set data-hovered and clear any active mouse hover", () => {
		const { $, pointer, hoveredIds } = setup();
		pointer("pointermove", $("plus1"), { pointerType: "mouse", clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);

		pointer("pointerdown", $("plus1"), { pointerType: "touch", clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual([]);

		pointer("pointermove", $("plus1"), { pointerType: "pen", clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual([]);
	});

	test("reconciles against elementFromPoint when a body overlay disappears", async () => {
		const { doc, $, pointer, setHit, hoveredIds, frame } = setup();
		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);

		// Simulate an overlay removed from <body> while the pointer is now over main
		const overlay = doc.createElement("div");
		doc.body.appendChild(overlay);
		setHit($("chat"));
		overlay.remove();
		await frame();
		expect(hoveredIds()).toEqual([]);

		// If the pointer is over another sidebar row when an overlay closes, hover transfers to it
		pointer("pointermove", overlay, { clientX: 256, clientY: 160 });
		setHit($("plus2"));
		doc.body.appendChild(overlay);
		overlay.remove();
		await frame();
		expect(hoveredIds()).toEqual(["dir2", "plus2"]);
	});

	test("reconciles when a hovered sidebar row disappears or the list scrolls", async () => {
		const { win, $, pointer, setHit, hoveredIds, frame } = setup();
		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);

		// Row disappears under stationary mouse; dir2 shifts into its place
		setHit($("plus2"));
		$("dir1").remove();
		await frame();
		expect(hoveredIds()).toEqual(["dir2", "plus2"]);

		// List scrolls so empty space is under the pointer
		setHit($("list"));
		$("list").dispatchEvent(new win.Event("scroll") as unknown as Event);
		await frame();
		expect(hoveredIds()).toEqual([]);
	});

	test("clears on window blur, pointercancel, document leave, hidden visibility, and inert wrapper", async () => {
		const { win, doc, $, pointer, hoveredIds, frame } = setup();

		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);
		win.dispatchEvent(new win.Event("blur") as unknown as Event);
		expect(hoveredIds()).toEqual([]);

		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		win.dispatchEvent(new win.Event("pointercancel") as unknown as Event);
		expect(hoveredIds()).toEqual([]);

		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		doc.documentElement.dispatchEvent(new win.Event("mouseleave") as unknown as Event);
		expect(hoveredIds()).toEqual([]);

		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		Object.defineProperty(doc, "hidden", { value: true, configurable: true });
		doc.dispatchEvent(new win.Event("visibilitychange") as unknown as Event);
		expect(hoveredIds()).toEqual([]);
		Object.defineProperty(doc, "hidden", { value: false, configurable: true });

		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);
		$("wrap").setAttribute("inert", "");
		await frame();
		expect(hoveredIds()).toEqual([]);
		$("wrap").removeAttribute("inert");

		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);
		$("wrap").classList.add("collapsed");
		await frame();
		expect(hoveredIds()).toEqual([]);
	});

	test("destroy clears active hover attributes and stops tracking", () => {
		const { $, action, pointer, hoveredIds } = setup();
		pointer("pointermove", $("plus1"), { clientX: 256, clientY: 120 });
		expect(hoveredIds()).toEqual(["dir1", "plus1"]);

		action.destroy?.();
		expect(hoveredIds()).toEqual([]);

		pointer("pointermove", $("plus2"), { clientX: 256, clientY: 160 });
		expect(hoveredIds()).toEqual([]);
	});
});
