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
import {
	applyVideoState,
	closeVideoView,
	controlVideoPlayer,
	disposeVideoPlayer,
	isVideoFullscreen,
	readVideoState,
	videoPlayer,
	type VideoPlayerOptions,
} from "../src/lib/video-view";

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

describe("videoPlayer unified viewer", () => {
	let win: Window;
	const g = globalThis as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	beforeEach(() => {
		win = new Window();
		for (const k of ["window", "document", "matchMedia", "Event", "KeyboardEvent", "history"]) saved[k] = g[k];
		// dialog.ts pushes a history entry for the back button
		g.history = { pushState: () => {}, go: () => {}, state: null };
		g.Event = win.Event;
		g.KeyboardEvent = win.KeyboardEvent;
		g.window = win;
		g.document = win.document;
		g.matchMedia = (q: string) => ({ matches: false, media: q });
	});
	afterEach(() => {
		closeVideoView();
		// a mounted player owns a copy-key listener on this window: release it so later files start clean
		for (const w of document.querySelectorAll<HTMLDivElement>(".wd-video-wrap")) disposeVideoPlayer(w);
		for (const k of Object.keys(saved)) g[k] = saved[k];
		win.close();
	});
	const tick = () => new Promise((r) => setTimeout(r, 0));
	const make = (opts?: VideoPlayerOptions) => {
		const w = videoPlayer("blob:x", opts) as unknown as HTMLDivElement;
		document.body.append(w);
		const v = w.querySelector("video") as unknown as HTMLVideoElement & Record<string, unknown>;
		// happy-dom has no media pipeline: make the element a controllable stub
		let paused = true;
		let ct = 0;
		let dur = 100;
		let rs = 1;
		Object.defineProperty(v, "paused", { get: () => paused, configurable: true });
		Object.defineProperty(v, "currentTime", { get: () => ct, set: (n: number) => (ct = n), configurable: true });
		Object.defineProperty(v, "duration", { get: () => dur, set: (n: number) => (dur = n), configurable: true });
		Object.defineProperty(v, "readyState", { get: () => rs, set: (n: number) => (rs = n), configurable: true });
		v.play = (async () => {
			paused = false;
		}) as never;
		v.pause = (() => {
			paused = true;
		}) as never;
		return { w, v };
	};
	const press = (init: KeyboardEventInit & { code: string }, target?: EventTarget) => {
		const e = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
		(target ?? document.body).dispatchEvent(e as unknown as Event);
		return e;
	};

	test("onExpand: full-screen button and dblclick call it instead of the standalone .open", () => {
		let n = 0;
		const { w, v } = make({ onExpand: () => n++ });
		w.querySelector<HTMLButtonElement>(".wd-video-full")!.click();
		v.dispatchEvent(new win.Event("dblclick") as unknown as Event);
		expect(n).toBe(2);
		expect(w.classList.contains("open")).toBe(false);
		expect(isVideoFullscreen()).toBe(false);
		expect(w.querySelector(".wd-video-top")).toBeNull();
	});

	test("standalone .open: top bar with title, copy, save, close; bar copy/save are hidden by css class scope", () => {
		const { w } = make({ filename: "demo.mp4", onCopy: async () => "ok", onDownload: async () => {} });
		w.querySelector<HTMLButtonElement>(".wd-video-full")!.click();
		expect(w.classList.contains("open")).toBe(true);
		expect(isVideoFullscreen()).toBe(true);
		expect(w.querySelector(".wd-video-title")!.textContent).toBe("demo.mp4");
		expect(w.querySelector(".wd-video-top .wd-video-top-copy")).not.toBeNull();
		expect(w.querySelector(".wd-video-top .wd-video-top-download")).not.toBeNull();
		w.querySelector<HTMLButtonElement>(".wd-video-top-close")!.click();
		expect(w.classList.contains("open")).toBe(false);
	});

	test("standalone .open: keyboard shortcuts", () => {
		const { w, v } = make({ filename: "a.mp4", onCopy: async () => "ok" });
		w.querySelector<HTMLButtonElement>(".wd-video-full")!.click();
		v.currentTime = 50;
		press({ code: "ArrowRight", key: "ArrowRight" });
		expect(v.currentTime).toBe(55);
		press({ code: "ArrowLeft", key: "ArrowLeft" });
		expect(v.currentTime).toBe(50);
		press({ code: "KeyL", key: "l" });
		expect(v.currentTime).toBe(60);
		press({ code: "KeyJ", key: "j" });
		expect(v.currentTime).toBe(50);
		const sp = press({ code: "Space", key: " " });
		expect(sp.defaultPrevented).toBe(true);
		expect(v.paused).toBe(false);
		press({ code: "KeyK", key: "k" });
		expect(v.paused).toBe(true);
		press({ code: "KeyM", key: "m" });
		expect(v.muted).toBe(true);
		expect(isVideoFullscreen()).toBe(true);
		press({ code: "KeyF", key: "f" });
		expect(isVideoFullscreen()).toBe(false);
		w.querySelector<HTMLButtonElement>(".wd-video-full")!.click();
		expect(isVideoFullscreen()).toBe(true);
		press({ code: "Escape", key: "Escape" });
		expect(isVideoFullscreen()).toBe(false);
	});

	test("standalone .open: range slider keeps arrows while Space still toggles; text inputs skip shortcuts", () => {
		const { w, v } = make();
		w.querySelector<HTMLButtonElement>(".wd-video-full")!.click();
		v.currentTime = 50;
		const seek = w.querySelector(".wd-video-seek")!;
		const a = press({ code: "ArrowRight", key: "ArrowRight" }, seek);
		expect(v.currentTime).toBe(50);
		expect(a.defaultPrevented).toBe(false);
		const s = press({ code: "Space", key: " " }, seek);
		expect(s.defaultPrevented).toBe(true);
		expect(v.paused).toBe(false);

		const text = document.createElement("input");
		text.type = "text";
		document.body.append(text);
		const m = press({ code: "KeyM", key: "m" }, text);
		const sp = press({ code: "Space", key: " " }, text);
		expect(m.defaultPrevented).toBe(false);
		expect(sp.defaultPrevented).toBe(false);
		expect(v.muted).toBe(false);
		expect(v.paused).toBe(false);
		text.remove();
	});

	test("lightbox mode: playback controls only, no expand, applies initialState", async () => {
		const idle: boolean[] = [];
		const w = videoPlayer("blob:x", {
			mode: "lightbox",
			initialState: { time: 12, rate: 1.5, volume: 0.4, muted: true, playing: true },
			onIdleChange: (v) => idle.push(v),
			onExpand: () => {
				throw new Error("no expand in lightbox");
			},
		}) as unknown as HTMLDivElement;
		expect(w.classList.contains("lightbox-mode")).toBe(true);
		const kids = [...w.querySelector(".wd-video-bar")!.children].map((c) => c.className.split(" ").find((n) => n.startsWith("wd-video-") && n !== "wd-video-btn"));
		expect(kids).toEqual(["wd-video-play", "wd-video-time", "wd-video-seek", "wd-video-speed", "wd-video-volbox"]);
		expect(w.querySelector(".wd-video-top")).toBeNull();
		const v = w.querySelector("video") as unknown as HTMLVideoElement;
		expect(v.playbackRate).toBe(1.5);
		expect(v.volume).toBe(0.4);
		expect(v.muted).toBe(true);
		v.dispatchEvent(new win.Event("dblclick") as unknown as Event);
		expect(w.classList.contains("open")).toBe(false);
		expect(idle).toEqual([]);
		disposeVideoPlayer(w);
	});

	test("read/apply/control helpers, including a non-finite duration", () => {
		const { w, v } = make();
		applyVideoState(w, { time: 20, rate: 2, volume: 2, muted: true, playing: false });
		expect(v.currentTime).toBe(20);
		expect(v.playbackRate).toBe(2);
		expect(v.volume).toBe(1);
		expect(readVideoState(w)).toEqual({ time: 20, rate: 2, volume: 1, muted: true, playing: false });
		controlVideoPlayer(w, { seekBy: -50 });
		expect(v.currentTime).toBe(0);
		controlVideoPlayer(w, { seekBy: 500 });
		expect(v.currentTime).toBe(100);
		(v as unknown as { duration: number }).duration = Number.NaN;
		v.currentTime = 5;
		controlVideoPlayer(w, { seekBy: 10 });
		expect(v.currentTime).toBe(15);
		controlVideoPlayer(w, { seekBy: Number.NaN });
		expect(v.currentTime).toBe(15);
		controlVideoPlayer(w, "toggle");
		expect(v.paused).toBe(false);
		controlVideoPlayer(w, "mute");
		expect(v.muted).toBe(false);
		expect(readVideoState(document.createElement("div"))).toBeNull();
	});

	test("lightbox mode: preserves initialState.time before loadedmetadata, then seeks & resumes (rejected play swallowed)", async () => {
		let played = 0;
		const proto = (win as unknown as { HTMLVideoElement: { prototype: { play: () => Promise<void> } } }).HTMLVideoElement.prototype;
		const orig = proto.play;
		proto.play = () => {
			played++;
			return Promise.reject(new Error("blocked"));
		};
		try {
			const w = videoPlayer("blob:x", {
				mode: "lightbox",
				initialState: { time: 7, rate: 1, volume: 1, muted: false, playing: true },
			}) as unknown as HTMLDivElement;
			const v = w.querySelector("video") as unknown as HTMLVideoElement;
			// before metadata loads, readVideoState still reports the pending target so closing never clobbers inline time with 0
			expect(readVideoState(w)?.time).toBe(7);
			expect(played).toBe(0);
			v.dispatchEvent(new win.Event("loadedmetadata") as unknown as Event);
			expect(v.currentTime).toBe(7);
			expect(played).toBe(1);
			await tick();
			disposeVideoPlayer(w);
		} finally {
			proto.play = orig;
		}
	});

	test("lightbox mode: onIdleChange fires when the bar hides and when it wakes", async () => {
		const idle: boolean[] = [];
		const w = videoPlayer("blob:x", { mode: "lightbox", onIdleChange: (v) => idle.push(v) }) as unknown as HTMLDivElement;
		document.body.append(w);
		const v = w.querySelector("video") as unknown as HTMLVideoElement;
		Object.defineProperty(v, "paused", { get: () => false, configurable: true });
		controlVideoPlayer(w, { seekBy: 1 }); // wakes: starts the idle timer, no change yet
		expect(idle).toEqual([]);
		await new Promise((r) => setTimeout(r, 2700));
		expect(idle).toEqual([true]);
		expect(w.classList.contains("idle")).toBe(true);
		controlVideoPlayer(w, { seekBy: 1 });
		expect(idle).toEqual([true, false]);
		disposeVideoPlayer(w);
	}, 6000);

	test("controlVideoPlayer wakes a hidden bar", () => {
		const { w } = make();
		w.classList.add("idle");
		controlVideoPlayer(w, "toggle");
		expect(w.classList.contains("idle")).toBe(false);
	});
});
