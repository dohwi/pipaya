import { describe, expect, test } from "bun:test";
import { bezier, dialogFrame, easeEnter, easeExit, ms, surfaceFrame } from "../src/lib/motion";
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
	test("dialogs scale and drop; exits move and shrink less than entrances", () => {
		const into = dialogFrame(1, "in");
		const out = dialogFrame(1, "out");
		expect(into).toEqual({ opacity: 0, y: 18, scale: 0.94 });
		expect(out).toEqual({ opacity: 0, y: 8, scale: 0.96 });
		expect(dialogFrame(0, "in")).toEqual({ opacity: 1, y: 0, scale: 1 });
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

describe("ripple", () => {
	test("diameter reaches the farthest corner", () => {
		expect(rippleSize(100, 40, 0, 0)).toBeCloseTo(2 * Math.hypot(100, 40));
		expect(rippleSize(100, 40, 50, 20)).toBeCloseTo(2 * Math.hypot(50, 20));
	});
});

import { indicatorBox, shouldSlide } from "../src/lib/sliding-indicator";

describe("sliding indicator", () => {
	const container = { left: 10, top: 20, width: 200, height: 400, scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 };
	test("places the marker in the container's content box, scroll included", () => {
		const row = { left: 18, top: 120, width: 184, height: 36 };
		expect(indicatorBox(container, row)).toEqual({ x: 8, y: 100, width: 184, height: 36 });
		expect(indicatorBox({ ...container, scrollTop: 50 }, row)).toEqual({ x: 8, y: 150, width: 184, height: 36 });
		expect(indicatorBox({ ...container, clientLeft: 1, clientTop: 1 }, row)).toEqual({ x: 7, y: 99, width: 184, height: 36 });
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
	test("the four split directions exist and the common two are bound", () => {
		const by = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
		for (const id of ["splitRight", "splitDown", "splitLeft", "splitUp"]) expect(by[id]?.group).toBe("layout");
		expect(by.splitRight.default).toBe("Mod+Backslash");
		expect(by.splitDown.default).toBe("Mod+Shift+Backslash");
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
		const s = markup(read("components/Modal.svelte"));
		expect(s).toMatch(/class="scrim"[^>]*in:fadeIn\|global out:fadeOut\|global/);
		expect(s).toMatch(/class="modal[^"]*"[\s\S]*?in:modalIn\|global\s+out:modalOut\|global/);
	});
	test("dialog panels go through the shared Modal instead of their own scrim", () => {
		for (const f of ["ServerForm", "Settings", "ModelSettings", "DirPicker", "QueueModal", "WorkBox", "CatalogPickerModal", "ModelPickerModal", "ModelConnections", "Extensions", "LinkCard", "UpdateBanner", "Skills", "Templates", "CloseConfirm"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toContain("<Modal");
			expect(s, f).not.toMatch(/class="r?scrim"/);
		}
	});
	test("dialog titles go through the shared header (one close button, one pull handle)", () => {
		for (const f of ["QueueModal", "ModelSettings", "DirPicker", "WorkBox", "FilePreview", "Skills", "Templates"]) {
			const s = markup(read(`components/${f}.svelte`));
			expect(s, f).toMatch(/<Modal\b[^\n]*\stitle=/);
			expect(s, f).not.toContain('aria-label={t("닫기")}');
		}
		for (const f of ["Settings", "ConnectModal", "ServerForm"]) expect(markup(read(`components/${f}.svelte`)), f).toContain("<ModalHeader");
	});
	test("Lightbox's layer uses global transitions", () => {
		const s = markup(read("components/Lightbox.svelte"));
		expect(s).toMatch(/class="lb"[^>]*in:fadeIn\|global out:fadeOut\|global/);
	});
	test("the extension approval dialog plays its exit instead of closing at once", () => {
		const s = read("components/extensions/ExtensionApproval.svelte");
		expect(s).toContain("closeAnimated(dialog)");
		// the buttons only settle the request; closing is driven by the request going away, so Esc and code paths animate too
		expect(s).not.toMatch(/resolveExtension\((true|false)\); dialog\.close\(\)/);
	});
	test("every component that is a bare modal root (no {#if} of its own) uses |global", () => {
		// ModelSettings, DirPicker: the modal sits at the top level of the file, outside any block
		for (const f of ["ModelSettings", "DirPicker"]) {
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
