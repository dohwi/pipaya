import { describe, expect, test } from "bun:test";
import { BackTrail, MouseNavController, browserNavKeyDirection, mouseNavDirection, type NavDirection } from "../src/lib/back-trail";

const all = () => true;

describe("back trail", () => {
	test("back and forward walk visited conversations in both directions", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "2" });
		t.visit({ server: "a", session: "3" });

		expect(t.back(all)).toEqual({ server: "a", session: "2" });
		t.visit({ server: "a", session: "2" });
		expect(t.depth).toBe(1);
		expect(t.forwardDepth).toBe(1);

		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: "1" });
		expect(t.depth).toBe(0);
		expect(t.forwardDepth).toBe(2);
		expect(t.back(all)).toBeNull();
		// Failing to go further back does not clobber the forward stack.
		expect(t.forwardDepth).toBe(2);

		expect(t.forward(all)).toEqual({ server: "a", session: "2" });
		t.visit({ server: "a", session: "2" });
		expect(t.forward(all)).toEqual({ server: "a", session: "3" });
		t.visit({ server: "a", session: "3" });
		expect(t.forward(all)).toBeNull();
		expect(t.depth).toBe(2);
		expect(t.forwardDepth).toBe(0);
	});

	test("opening a new conversation after stepping back clears the forward stack", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "2" });
		t.visit({ server: "a", session: "3" });
		expect(t.back(all)).toEqual({ server: "a", session: "2" });
		t.visit({ server: "a", session: "2" });
		expect(t.forwardDepth).toBe(1);

		// Re-visiting the same conversation keeps the forward stack intact.
		t.visit({ server: "a", session: "2" });
		expect(t.forwardDepth).toBe(1);

		// Navigating elsewhere starts a new branch and clears forward history.
		t.visit({ server: "a", session: "4" });
		expect(t.forwardDepth).toBe(0);
		expect(t.forward(all)).toBeNull();
		expect(t.back(all)).toEqual({ server: "a", session: "2" });
	});

	test("the blank new-chat screen is never a page to come back to or go forward to", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: null });
		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: "1" });
		expect(t.forward(all)).toBeNull();

		t.visit({ server: "a", session: null });
		t.visit({ server: "a", session: "2" });
		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: "1" });
		expect(t.back(all)).toBeNull();
		expect(t.forward(all)).toEqual({ server: "a", session: "2" });
	});

	test("crossing servers passes through a blank screen without losing back or forward history", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "b", session: null });
		t.visit({ server: "b", session: "9" });

		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: null });
		t.visit({ server: "a", session: "1" });
		expect(t.depth).toBe(0);
		expect(t.forwardDepth).toBe(1);
		expect(t.back(all)).toBeNull();

		expect(t.forward(all)).toEqual({ server: "b", session: "9" });
		t.visit({ server: "b", session: null });
		t.visit({ server: "b", session: "9" });
		expect(t.depth).toBe(1);
		expect(t.forwardDepth).toBe(0);
		expect(t.forward(all)).toBeNull();
	});

	test("rapid back/forward before the screen finishes landing still lands cleanly", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "2" });
		t.visit({ server: "a", session: "3" });

		expect(t.back(all)).toEqual({ server: "a", session: "2" });
		expect(t.back(all)).toEqual({ server: "a", session: "1" });
		expect(t.forward(all)).toEqual({ server: "a", session: "2" });
		t.visit({ server: "a", session: "2" });
		expect(t.depth).toBe(1);
		expect(t.forwardDepth).toBe(1);
		expect(t.forward(all)).toEqual({ server: "a", session: "3" });
	});

	test("closed conversations and the one on screen are skipped in both directions", () => {
		const t = new BackTrail();
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "gone" });
		t.visit({ server: "a", session: "1" });
		t.visit({ server: "a", session: "3" });
		t.visit({ server: "a", session: "1" });
		expect(t.back((p) => p.session !== "gone")).toEqual({ server: "a", session: "3" });
		t.visit({ server: "a", session: "3" });
		expect(t.back((p) => p.session !== "gone")).toEqual({ server: "a", session: "1" });
		t.visit({ server: "a", session: "1" });
		expect(t.back((p) => p.session !== "gone")).toBeNull();

		// Forward skips conversations that were closed since stepping back and the one already on screen.
		expect(t.forward((p) => p.session !== "3")).toBeNull();
		expect(t.depth).toBe(0);

		const t2 = new BackTrail();
		t2.visit({ server: "a", session: "1" });
		t2.visit({ server: "a", session: "2" });
		t2.visit({ server: "a", session: "3" });
		expect(t2.back(all)).toEqual({ server: "a", session: "2" });
		t2.visit({ server: "a", session: "2" });
		expect(t2.back(all)).toEqual({ server: "a", session: "1" });
		t2.visit({ server: "a", session: "1" });
		expect(t2.forward((p) => p.session !== "2")).toEqual({ server: "a", session: "3" });
		t2.visit({ server: "a", session: "3" });
		expect(t2.back(all)).toEqual({ server: "a", session: "1" });
		t2.visit({ server: "a", session: "1" });
		// If every forward entry is gone, forward returns null and does not push current onto backStack.
		expect(t2.forward(() => false)).toBeNull();
		expect(t2.depth).toBe(0);
	});

	test("keeps at most `max` pages in each stack", () => {
		const t = new BackTrail(3);
		for (let i = 0; i < 10; i++) t.visit({ server: "a", session: String(i) });
		expect(t.depth).toBe(3);
		for (let i = 0; i < 3; i++) {
			const page = t.back(all);
			expect(page).not.toBeNull();
			t.visit(page!);
		}
		expect(t.forwardDepth).toBe(3);
		expect(t.back(all)).toBeNull();
	});
});

describe("mouse and browser nav helpers", () => {
	test("maps mouse buttons 3/4 and BrowserBack/BrowserForward keys", () => {
		expect(mouseNavDirection(0)).toBeNull();
		expect(mouseNavDirection(1)).toBeNull();
		expect(mouseNavDirection(2)).toBeNull();
		expect(mouseNavDirection(3)).toBe("back");
		expect(mouseNavDirection(4)).toBe("forward");
		expect(mouseNavDirection(5)).toBeNull();

		expect(browserNavKeyDirection({ key: "BrowserBack", code: "BrowserBack" })).toBe("back");
		expect(browserNavKeyDirection({ key: "BrowserForward", code: "BrowserForward" })).toBe("forward");
		expect(browserNavKeyDirection({ key: "Unidentified", code: "BrowserBack" })).toBe("back");
		expect(browserNavKeyDirection({ key: "BrowserForward", code: "" })).toBe("forward");
		expect(browserNavKeyDirection({ key: "ArrowLeft", code: "ArrowLeft" })).toBeNull();
	});

	test("MouseNavController fires once per click, cancels defaults, and handles up-only drivers", () => {
		const seen: NavDirection[] = [];
		const ctrl = new MouseNavController((dir) => seen.push(dir));
		const mk = (button: number) => {
			let prevented = false;
			return {
				button,
				preventDefault() {
					prevented = true;
				},
				get prevented() {
					return prevented;
				},
			};
		};

		// Primary / middle / right clicks are untouched.
		for (const btn of [0, 1, 2]) {
			const d = mk(btn);
			const u = mk(btn);
			const a = mk(btn);
			expect(ctrl.down(d)).toBe(false);
			expect(ctrl.up(u)).toBe(false);
			expect(ctrl.auxClick(a)).toBe(false);
			expect(d.prevented || u.prevented || a.prevented).toBe(false);
		}
		expect(seen).toEqual([]);

		// Normal down + up + auxclick fires once on down and prevents default on all three.
		const d3 = mk(3);
		const u3 = mk(3);
		const a3 = mk(3);
		expect(ctrl.down(d3)).toBe(true);
		expect(ctrl.up(u3)).toBe(true);
		expect(ctrl.auxClick(a3)).toBe(true);
		expect(d3.prevented && u3.prevented && a3.prevented).toBe(true);
		expect(seen).toEqual(["back"]);

		// Up-only delivery (no prior down) still navigates once.
		const u4 = mk(4);
		expect(ctrl.up(u4)).toBe(true);
		expect(u4.prevented).toBe(true);
		expect(seen).toEqual(["back", "forward"]);

		// Overlapping presses on both side buttons track each button independently.
		expect(ctrl.down(mk(3))).toBe(true);
		expect(ctrl.down(mk(4))).toBe(true);
		expect(ctrl.up(mk(3))).toBe(true);
		expect(ctrl.up(mk(4))).toBe(true);
		expect(seen).toEqual(["back", "forward", "back", "forward"]);

		// Reset on blur clears orphaned downs so a later up-only event works.
		expect(ctrl.down(mk(3))).toBe(true);
		ctrl.reset();
		expect(ctrl.up(mk(3))).toBe(true);
		expect(seen).toEqual(["back", "forward", "back", "forward", "back", "back"]);
	});
});
