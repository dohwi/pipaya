import { describe, expect, test } from "bun:test";
import { clock, nextSpeed, speedLabel } from "../src/lib/video-view";

test("clock writes m:ss, and h:mm:ss from an hour on", () => {
	expect(clock(0)).toBe("0:00");
	expect(clock(5.9)).toBe("0:05");
	expect(clock(83)).toBe("1:23");
	expect(clock(3725)).toBe("1:02:05");
});

test("clock treats unknown durations as zero", () => {
	expect(clock(NaN)).toBe("0:00");
	expect(clock(Infinity)).toBe("0:00");
	expect(clock(-3)).toBe("0:00");
});

test("the speed button steps 1× → 1.25× → 1.5× → 2× → 0.5× and wraps to 1×", () => {
	const seen = [1];
	for (let i = 0; i < 5; i++) seen.push(nextSpeed(seen[seen.length - 1]));
	expect(seen).toEqual([1, 1.25, 1.5, 2, 0.5, 1]);
	expect(nextSpeed(3)).toBe(1);
});

test("speedLabel writes the rate with a ×", () => {
	expect(speedLabel(1)).toBe("1×");
	expect(speedLabel(1.25)).toBe("1.25×");
});

// ── download button (DOM)
import { afterEach, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { disposeVideoPlayer, videoPlayer, type VideoPlayerOptions } from "../src/lib/video-view";

describe("videoPlayer download button", () => {
	let win: Window;
	const g = globalThis as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	beforeEach(() => {
		win = new Window();
		for (const k of ["window", "document", "matchMedia", "Event"]) saved[k] = g[k];
		g.Event = win.Event;
		g.window = win;
		g.document = win.document;
		g.matchMedia = (q: string) => ({ matches: false, media: q });
	});
	afterEach(() => {
		for (const k of Object.keys(saved)) g[k] = saved[k];
		win.close();
	});
	const make = (opts?: VideoPlayerOptions) => videoPlayer("blob:x", opts) as unknown as HTMLElement;
	const dl = (w: HTMLElement) => w.querySelector<HTMLButtonElement>(".wd-video-download");
	const tick = () => new Promise((r) => setTimeout(r, 0));

	test("shown by default, between the other tools and full screen", () => {
		const w = make({ onDownload: async () => {} });
		expect(dl(w)).not.toBeNull();
		expect(w.classList.contains("dl-fullscreen-only")).toBe(false);
		const bar = w.querySelector(".wd-video-bar")!;
		expect(bar.lastElementChild?.classList.contains("wd-video-full")).toBe(true);
		expect(bar.lastElementChild?.previousElementSibling).toBe(dl(w) as unknown as Element);
	});
	test("download: false leaves it out; \"fullscreen\" marks the wrapper", () => {
		expect(dl(make({ download: false }))).toBeNull();
		const w = make({ download: "fullscreen" });
		expect(dl(w)).not.toBeNull();
		expect(w.classList.contains("dl-fullscreen-only")).toBe(true);
	});
	test("click saves once while in flight, then flashes a check and notes success", async () => {
		let calls = 0;
		let release!: () => void;
		const w = make({ onDownload: () => (calls++, new Promise<void>((r) => (release = r))) });
		const b = dl(w)!;
		const before = b.querySelector("path")!.getAttribute("d");
		b.click();
		b.click();
		expect(calls).toBe(1);
		expect(b.disabled).toBe(true);
		release();
		await tick();
		expect(b.disabled).toBe(false);
		expect(b.querySelector("path")!.getAttribute("d")).not.toBe(before);
		expect(w.querySelector(".wd-video-note.show")).not.toBeNull();
		expect(w.querySelector(".wd-video-note.err")).toBeNull();
		disposeVideoPlayer(w as unknown as HTMLDivElement);
	});
	test("a cancelled dialog (false) stays silent", async () => {
		const w = make({ onDownload: async () => false });
		const b = dl(w)!;
		const before = b.querySelector("path")!.getAttribute("d");
		b.click();
		await tick();
		expect(b.disabled).toBe(false);
		expect(b.querySelector("path")!.getAttribute("d")).toBe(before);
		expect(w.querySelector(".wd-video-note")).toBeNull();
	});
	test("a rejection shows the error note and unlocks", async () => {
		const w = make({ onDownload: async () => Promise.reject(new Error("x")) });
		const b = dl(w)!;
		b.click();
		await tick();
		expect(b.disabled).toBe(false);
		expect(w.querySelector(".wd-video-note.err.show")).not.toBeNull();
		disposeVideoPlayer(w as unknown as HTMLDivElement);
	});
	test("dispose clears the check timer and ignores in-flight completion", async () => {
		let release!: () => void;
		const w = make({ onDownload: () => new Promise<void>((r) => (release = r)) });
		const b = dl(w)!;
		const before = b.querySelector("path")!.getAttribute("d");
		b.click();
		disposeVideoPlayer(w as unknown as HTMLDivElement);
		release();
		await tick();
		// disposed mid-flight: no check glyph swap or note scheduled after teardown
		expect(b.querySelector("path")!.getAttribute("d")).toBe(before);
		expect(w.querySelector(".wd-video-note")).toBeNull();
	});
});
