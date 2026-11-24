import { describe, expect, test } from "bun:test";
import { bezier, clipSlide, cssMs, dialogFrame, easeEnter, easeExit, modalIn, modalQuickIn, ms, surfaceFrame } from "../src/lib/motion";
import { rippleSize } from "../src/lib/ripple";

describe("bezier", () => {
	test("is anchored at both ends and linear for the identity curve", () => {
		for (const f of [easeEnter, easeExit, bezier(0.2, 0, 0, 1)]) {
			expect(f(0)).toBe(0);
			expect(f(1)).toBe(1);
		}
		expect(bezier(0.25, 0.25, 0.75, 0.75)(0.3)).toBe(0.3);
	});
	test("entrance decelerates (fast start), exit accelerates (slow start)", () => {
		expect(easeEnter(0.2)).toBeGreaterThan(0.2);
		expect(easeExit(0.2)).toBeLessThan(0.2);
	});
	test("is monotonic", () => {
		for (const f of [easeEnter, easeExit]) {
			let last = -1;
			for (let t = 0; t <= 1.0001; t += 0.05) {
				const v = f(Math.min(t, 1));
				expect(v).toBeGreaterThanOrEqual(last - 1e-9);
				last = v;
			}
		}
	});
});

describe("frames", () => {
	test("dialogs rise into place and never scale", () => {
		const into = dialogFrame(1, "in");
		const out = dialogFrame(1, "out");
		// u = 1 is fully away: the entrance starts below its place and the exit leaves downward, less far than it came
		expect(into).toEqual({ opacity: 0, y: 16, scale: 1 });
		expect(out).toEqual({ opacity: 0, y: 6, scale: 1 });
		expect(out.y).toBeLessThan(into.y);
		expect(dialogFrame(0, "in")).toEqual({ opacity: 1, y: 0, scale: 1 });
		for (const dir of ["in", "out"] as const) for (const u of [0, 0.5, 1]) expect(dialogFrame(u, dir).scale).toBe(1);
		// a quick look comes in faster and from half as far
		const node = {} as Element;
		expect(modalQuickIn(node).duration).toBeLessThan(modalIn(node).duration);
		expect(modalQuickIn(node).css!(0, 1)).toContain("translateY(8.00px)");
	});
	test("surfaces never scale (a large panel scaling wobbles every edge)", () => {
		for (const dir of ["in", "out"] as const) for (const u of [0, 0.5, 1]) expect(surfaceFrame(u, 10, dir).scale).toBe(1);
		expect(Math.abs(surfaceFrame(1, 10, "out").y)).toBeLessThan(Math.abs(surfaceFrame(1, 10, "in").y));
	});
});

describe("ms", () => {
	test("falls back to the Material profile outside a browser", () => {
		expect([ms("fast"), ms("normal"), ms("slow")]).toEqual([180, 360, 460]);
	});
});

describe("cssMs", () => {
	test("reads ms and s (the minified build writes 360ms as .36s)", () => {
		expect(cssMs("360ms")).toBe(360);
		expect(cssMs(" .36s ")).toBeCloseTo(360);
		expect(cssMs("0.18s")).toBeCloseTo(180);
		expect(cssMs("460")).toBe(460);
		expect(cssMs("")).toBeNaN();
	});
});

describe("ripple", () => {
	test("diameter reaches the farthest corner", () => {
		expect(rippleSize(100, 40, 0, 0)).toBeCloseTo(2 * Math.hypot(100, 40));
		expect(rippleSize(100, 40, 50, 20)).toBeCloseTo(2 * Math.hypot(50, 20));
	});
});

import { clipToRect, indicatorBox, shouldSlide } from "../src/lib/sliding-indicator";

describe("sliding indicator", () => {
	const container = { left: 10, top: 20, width: 200, height: 400, scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 };
	test("places the marker in the container's content box, scroll included", () => {
		const row = { left: 18, top: 120, width: 184, height: 36 };
		expect(indicatorBox(container, row)).toEqual({ x: 8, y: 100, width: 184, height: 36 });
		expect(indicatorBox({ ...container, scrollTop: 50 }, row)).toEqual({ x: 8, y: 150, width: 184, height: 36 });
		expect(indicatorBox({ ...container, clientLeft: 1, clientTop: 1 }, row)).toEqual({ x: 7, y: 99, width: 184, height: 36 });
	});
	test("clips to overflow:hidden/clip ancestors and hides once clipped out of view", () => {
		const row = { left: 18, top: 120, width: 184, height: 32 };
		// No clipping ancestors or ancestor larger than row: unchanged.
		expect(clipToRect(row, [])).toEqual(row);
		expect(clipToRect(row, [{ rect: { left: 10, top: 80, width: 220, height: 100 }, x: true, y: true }])).toEqual(row);
		// Collapsing fold clips the bottom edge during the transition.
		expect(clipToRect(row, [{ rect: { left: 10, top: 80, width: 220, height: 56 }, x: true, y: true }])).toEqual({ left: 18, top: 120, width: 184, height: 16 });
		// Collapsing fold moved past the row's top: returns null so the indicator hides instead of floating below the card.
		expect(clipToRect(row, [{ rect: { left: 10, top: 80, width: 220, height: 40 }, x: true, y: true }])).toBeNull();
		expect(clipToRect(row, [{ rect: { left: 10, top: 80, width: 220, height: 0 }, x: true, y: true }])).toBeNull();
		// Axis-selective clipping ignores overflow-y when only x is clipped.
		expect(clipToRect(row, [{ rect: { left: 10, top: 80, width: 220, height: 10 }, x: true, y: false }])).toEqual(row);
	});
	test("hides when either side cannot be measured (display:none, nothing selected)", () => {
		expect(indicatorBox(container, undefined)).toBeNull();
		expect(indicatorBox(container, { left: 0, top: 0, width: 0, height: 36 })).toBeNull();
		expect(indicatorBox({ ...container, width: 0 }, { left: 0, top: 0, width: 10, height: 10 })).toBeNull();
	});
	test("only a different target slides; first placement and reflow snap", () => {
		const a = {}, b = {};
		expect(shouldSlide(null, a)).toBe(false);
		expect(shouldSlide(a, a)).toBe(false);
		expect(shouldSlide(a, b)).toBe(true);
	});
	test("a list that was replaced (the old target is gone) snaps instead of sliding in from nowhere", () => {
		const a = {}, b = {};
		expect(shouldSlide(a, b, false)).toBe(false);
		expect(shouldSlide(a, b, true)).toBe(true);
	});
});

import { edgeBox } from "../src/lib/sliding-indicator";
import { nextIndex } from "../src/lib/roving";

describe("sliding indicator inside a scaling dialog", () => {
	const base = { left: 100, top: 100, width: 470, height: 300, scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 };
	test("screen pixels are divided by the ancestor scale to get layout pixels", () => {
		// the dialog is mid-entrance at .94: a 100px-wide item at 47px offset is 94 screen px / 44.18 offset
		const box = indicatorBox({ ...base, scaleX: 0.94, scaleY: 0.94 }, { left: 144.18, top: 100, width: 94, height: 37.6 });
		expect(box!.x).toBeCloseTo(47, 1);
		expect(box!.width).toBeCloseTo(100, 1);
		expect(box!.height).toBeCloseTo(40, 1);
	});
	test("no scale (or a zero scale) behaves as 1", () => {
		const item = { left: 150, top: 120, width: 80, height: 30 };
		expect(indicatorBox(base, item)).toEqual(indicatorBox({ ...base, scaleX: 1, scaleY: 1 }, item));
		expect(indicatorBox({ ...base, scaleX: 0, scaleY: 0 }, item)).toEqual(indicatorBox(base, item));
	});
	test("underline tabs collapse the box onto the bottom edge", () => {
		expect(edgeBox({ x: 10, y: 4, width: 90, height: 40 }, 2)).toEqual({ x: 10, y: 42, width: 90, height: 2 });
	});
});

describe("roving keys", () => {
	test("arrows wrap, Home/End jump, anything else is ignored", () => {
		expect(nextIndex("ArrowRight", 3, 4)).toBe(0);
		expect(nextIndex("ArrowLeft", 0, 4)).toBe(3);
		expect(nextIndex("ArrowRight", 1, 4)).toBe(2);
		expect(nextIndex("Home", 2, 4)).toBe(0);
		expect(nextIndex("End", 0, 4)).toBe(3);
		expect(nextIndex("a", 0, 4)).toBeNull();
		expect(nextIndex("ArrowRight", -1, 4)).toBeNull(); // focus is not inside the group
		expect(nextIndex("ArrowRight", 0, 0)).toBeNull();
	});
});

import { ACTIONS } from "../src/lib/keys";

describe("shortcut catalogue", () => {
	test("no two actions share a default key", () => {
		const bound = ACTIONS.map((a) => a.default).filter(Boolean);
		expect(new Set(bound).size).toBe(bound.length);
	});
	test("the left sidebar's toggle is Mod+B, B", () => {
		const by = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
		expect(by.toggleSidebar.default).toBe("Mod+B+B");
	});
	test("the two split directions are bound", () => {
		const by = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
		for (const id of ["splitRight", "splitDown"]) expect(by[id]?.group).toBe("layout");
		expect(by.splitRight.default).toBe("Mod+B+Backslash");
		expect(by.splitDown.default).toBe("Mod+B+Minus");
	});
});

/**
 * Svelte plays a local `in:` only when the block that directly contains the element is itself switched on. A modal
 * that is the root of a component the *parent* shows with `{#if}` has no such block of its own, so its enter and exit
 * silently do nothing unless the transition is `|global`. (Found in ServerForm and Lightbox.)
 */
describe("modals mounted by their parent animate", () => {
	const { readFileSync } = require("node:fs") as typeof import("node:fs");
	const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
	const markup = (src: string) => src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "");

	test("the shared Modal's scrim and panel use global transitions", () => {
		const s = markup(read("components/ui/Modal.svelte"));
		expect(s).toMatch(/class="scrim"[^>]*in:fadeIn\|global out:fadeOut\|global/);
		expect(s).toMatch(/class="modal[^"]*"[\s\S]*?in:enter\|global\s+out:modalOut\|global/);
		// `enter` is modalIn, or the quicker modalQuickIn for a quick look
		expect(read("components/ui/Modal.svelte")).toMatch(/const enter = \(node: Element\) => \(quick \? modalQuickIn\(node\) : modalIn\(node\)\)/);
	});
	test("the scrim closes only on a press that started on it (not the click of the tap that opened the dialog)", () => {
		const s = markup(read("components/ui/Modal.svelte"));
		expect(s).toMatch(/class="scrim"[^>]*onpointerdown=\{press\}[^>]*onclick=\{dismiss\}/);
		expect(read("components/ui/Modal.svelte")).toMatch(/if \(own && dismissible\) onclose\(\)/);
	});
	test("dialog panels go through the shared Modal instead of their own scrim", () => {
		for (const f of ["server/ServerForm", "settings/Settings", "server/DirPicker", "chat/QueueModal", "models/ConnectionForm", "extensions/ImportDialogs", "agent/SkillsDialog", "agent/CommandFamiliesDialog", "ui/PickerModal", "ui/ConfirmDialog", "chat/StatusCard"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toContain("<Modal");
			expect(s, f).not.toMatch(/class="r?scrim"/);
		}
	});
	test("confirmations and status cards are the shared ConfirmDialog / StatusCard, never their own Modal", () => {
		for (const f of ["shell/DiscardConfirm", "shell/CloseConfirm", "shell/SessionCloseConfirm", "extensions/RemoveExtensionConfirm", "extensions/PairInstallConfirm"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toContain("<ConfirmDialog");
			expect(s, f).not.toContain("<Modal");
		}
		for (const f of ["chat/LinkCard", "shell/UpdateBanner"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toContain("<StatusCard");
			expect(s, f).not.toContain("<Modal");
		}
	});
	test("ConfirmDialog attaches sheetPull and sheet.ts recognises role=alertdialog", () => {
		const cd = read("components/ui/ConfirmDialog.svelte");
		expect(cd).toContain("use:sheetPull=");
		expect(cd).toContain("disabled: !sheet || busy");
		expect(read("lib/sheet.ts")).toContain('[role="alertdialog"]');
	});
	test("mobile bottom sheets keep grabber/sheetPull consistent and clear safe areas", () => {
		// Full-screen sheets (`full`) must not draw a bottom-sheet pull handle
		expect(read("components/ui/Modal.svelte")).toContain("pull={sheet && !full}");
		// Workspace & import modals use bottom-sheet mode with safe-area padding on phones
		expect(read("components/agent/SessionsDialog.svelte")).toContain("safeArea");
		const market = read("components/extensions/Marketplace.svelte");
		expect(market).toContain("safeArea");
		expect(market).not.toContain("sheet={false}");
		const imp = read("components/extensions/ImportDialogs.svelte");
		expect(imp).toContain("use:sheetPull=");
		expect(imp).not.toContain("sheet={false}");
		expect(imp).toContain("<DialogFooter safe>");
		expect(imp).toContain("<DialogFooter rule safe wrap>");
	});
	test("the address form is a step inside ConnectModal (embedded), not a second dialog opened over it", () => {
		expect(markup(read("components/server/ConnectModal.svelte"))).toContain("<ConnectionForm embedded");
		const host = markup(read("components/models/ModelConnections.svelte"));
		// only editing opens ConnectionForm as a dialog of its own
		expect(host).not.toContain("oncustom");
		expect(read("components/models/ModelConnections.svelte")).toContain('kind: "edit"');
	});
	test("dialog titles go through the shared header (one close button, one pull handle)", () => {
		for (const f of ["chat/QueueModal", "server/DirPicker", "chat/FilePreview", "agent/SkillsDialog", "agent/CommandFamiliesDialog"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toMatch(/<Modal\b[^\n]*\stitle=/);
			expect(s, f).not.toContain('aria-label={t("닫기")}');
		}
		for (const f of ["settings/Settings", "server/ConnectModal", "server/ServerForm"]) expect(markup(read(`components/${f}.svelte`)), f).toContain("<ModalHeader");
	});
	test("every model / catalog picker is the shared PickerModal, and every model button the shared ModelField", () => {
		for (const f of ["models/ModelPickerModal", "models/CatalogPickerModal"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toContain("<PickerModal");
			expect(s, f).not.toContain("<Modal");
		}
		const picker = markup(read("components/models/ModelPicker.svelte"));
		expect(picker).toContain("<ModelField");
		expect(picker).not.toContain("<ModelPickerModal");
	});
	test("Lightbox's layer uses global transitions", () => {
		const s = markup(read("components/chat/Lightbox.svelte"));
		expect(s).toMatch(/class="lb"[^>]*in:fadeIn\|global out:fadeOut\|global/);
	});
	test("the extension approval, request and panel dialogs are the shared Modal, never native <dialog>", () => {
		for (const f of ["extensions/ExtensionApproval", "extensions/ExtensionDialog", "extensions/ExtensionPanels"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toContain("<Modal");
			expect(s, f).not.toContain("<dialog");
		}
		// the buttons only settle the request; the {#if} on the request closes the modal, so Esc and code paths animate too
		expect(read("components/extensions/ExtensionApproval.svelte")).toContain("{#if app.extensionRequests.approval}");
		expect(read("components/extensions/ExtensionDialog.svelte")).toContain("{#if app.extensionRequests.dialog}");
	});
	test("every component that is a bare modal root (no {#if} of its own) uses |global", () => {
		// DirPicker: the modal sits at the top level of the file, outside any block
		for (const f of ["server/DirPicker"]) {
			const top = markup(read(`components/${f}.svelte`));
			const first = top.search(/<Modal\b/);
			const before = top.slice(0, first);
			const opened = (before.match(/\{#(if|each|key|await)\b/g) ?? []).length;
			const closed = (before.match(/\{\/(if|each|key|await)\}/g) ?? []).length;
			expect(opened - closed).toBe(0); // not inside a block of its own
		}
	});
});

describe("motion goes through lib/motion", () => {
	const { readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
	const { join } = require("node:path") as typeof import("node:path");
	const root = new URL("../src/", import.meta.url).pathname;
	const files = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".svelte") ? [join(dir, e.name)] : []));
	test("no component imports svelte/transition or svelte/animate itself (tokens + reduced motion live in one place)", () => {
		for (const f of files(root)) {
			expect(readFileSync(f, "utf8"), f).not.toMatch(/from "svelte\/(transition|animate)"/);
		}
	});
	test("no hard-coded transition durations in component styles", () => {
		for (const f of files(root)) {
			const css = readFileSync(f, "utf8").match(/<style[\s\S]*?<\/style>/)?.[0] ?? "";
			expect(css, f).not.toMatch(/transition:[^;]*[\s,](?:[1-9]\d*|\d*\.\d*[1-9])m?s\b/);
		}
	});
});

describe("model icon image cache", () => {
	test("peekIconImage returns nothing until the image has been loaded, then the same URL at once", async () => {
		const { peekIconImage, loadIconImage } = await import("../src/lib/model-icon-image");
		const conn = { baseUrl: "http://x.test", token: "t" };
		expect(peekIconImage(conn, "img:a")).toBeNull();
		const realFetch = globalThis.fetch;
		const realCreate = URL.createObjectURL;
		globalThis.fetch = (async () => new Response(new Blob(["x"]), { status: 200 })) as unknown as typeof fetch;
		URL.createObjectURL = () => "blob:test-1";
		try {
			const url = await loadIconImage(conn, "img:a");
			await Promise.resolve();
			expect(url).toBe("blob:test-1");
			expect(peekIconImage(conn, "img:a")).toBe("blob:test-1");
			expect(peekIconImage(conn, "img:b")).toBeNull();
		} finally {
			globalThis.fetch = realFetch;
			URL.createObjectURL = realCreate;
		}
	});
});

describe("clipSlide", () => {
	test("clips with overflow: clip so the first row's margin keeps collapsing while it slides", () => {
		const style = { display: "block", opacity: "1", height: "96px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" };
		const real = globalThis.getComputedStyle;
		globalThis.getComputedStyle = (() => style) as unknown as typeof getComputedStyle;
		try {
			const css = clipSlide({} as Element, { duration: 100, easing: (t) => t }).css!(0.5, 0.5);
			expect(css).toContain("overflow: clip;");
			expect(css.indexOf("overflow: hidden;")).toBeLessThan(css.indexOf("overflow: clip;")); // fallback first
			expect(css).toContain("height: 48px");
		} finally {
			globalThis.getComputedStyle = real;
		}
	});
});
