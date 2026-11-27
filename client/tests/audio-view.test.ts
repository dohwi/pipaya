import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { audioPlayer, disposeAudioPlayer, type AudioPlayerOptions } from "../src/lib/audio-view";

describe("audioPlayer", () => {
	let win: Window;
	const g = globalThis as Record<string, unknown>;
	const saved: Record<string, unknown> = {};
	beforeEach(() => {
		win = new Window();
		for (const k of ["window", "document", "matchMedia", "Event", "KeyboardEvent"]) saved[k] = g[k];
		g.Event = win.Event;
		g.KeyboardEvent = win.KeyboardEvent;
		g.window = win;
		g.document = win.document;
		g.matchMedia = (q: string) => ({ matches: false, media: q });
	});
	afterEach(() => {
		for (const k of Object.keys(saved)) g[k] = saved[k];
		win.close();
	});

	const tick = () => new Promise((r) => setTimeout(r, 0));
	const make = (opts?: AudioPlayerOptions) => {
		const w = audioPlayer("blob:x", opts) as unknown as HTMLElement;
		const audio = w.querySelector("audio") as HTMLAudioElement;
		// happy-dom has no media pipeline: a tiny fake of play / pause state
		let paused = true;
		const calls = { play: 0, pause: 0 };
		Object.defineProperty(audio, "paused", { get: () => paused, configurable: true });
		audio.play = () => {
			calls.play++;
			paused = false;
			audio.dispatchEvent(new win.Event("play") as unknown as Event);
			return Promise.resolve();
		};
		audio.pause = () => {
			calls.pause++;
			paused = true;
			audio.dispatchEvent(new win.Event("pause") as unknown as Event);
		};
		Object.defineProperty(audio, "duration", { get: () => 100, configurable: true });
		return { w, audio, calls };
	};
	const q = <T extends HTMLElement>(w: HTMLElement, sel: string) => w.querySelector<T>(sel);
	const d = (b: HTMLElement | null) => b?.querySelector("path")?.getAttribute("d");
	const key = (w: HTMLElement, init: Record<string, unknown>, target: HTMLElement = w) => {
		const e = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
		target.dispatchEvent(e as unknown as Event);
		return e;
	};

	test("default structure: hidden audio, controls in order, wrap focusable", () => {
		const { w, audio } = make({ copy: false });
		expect(w.className).toBe("wd-audio-wrap");
		expect(w.tabIndex).toBe(0);
		expect(audio.controls).toBe(false);
		expect(audio.preload).toBe("metadata");
		expect(audio.className).toBe("wd-audio");
		const order = [...w.children].map((c) => c.className.split(" ")[0] + (c.className.includes("-btn") ? " " + c.className.split(" ")[1] : ""));
		expect(order).toEqual(["wd-audio", "wd-audio-btn wd-audio-play", "wd-audio-time", "wd-audio-seek", "wd-audio-btn wd-audio-speed", "wd-audio-btn wd-audio-mute", "wd-audio-btn wd-audio-download"]);
		const seek = q<HTMLInputElement>(w, ".wd-audio-seek")!;
		expect([seek.min, seek.max, seek.step, seek.type]).toEqual(["0", "1000", "1", "range"]);
		expect(seek.getAttribute("aria-label")).toBeTruthy();
		expect(q(w, ".wd-audio-time")!.textContent).toBe("0:00 / 0:00");
		expect(q(w, ".wd-audio-copy")).toBeNull();
	});

	test("download: false and copy: false leave the buttons out; copy: true adds it before download", () => {
		const a = make({ download: false, copy: false }).w;
		expect(q(a, ".wd-audio-download")).toBeNull();
		expect(q(a, ".wd-audio-copy")).toBeNull();
		const b = make({ copy: true }).w;
		expect(q(b, ".wd-audio-copy")!.nextElementSibling).toBe(q(b, ".wd-audio-download") as unknown as Element);
	});

	test("play button toggles play / pause and swaps the glyph", () => {
		const { w, calls } = make({ copy: false });
		const p = q<HTMLButtonElement>(w, ".wd-audio-play")!;
		const before = d(p);
		p.click();
		expect(calls.play).toBe(1);
		expect(d(p)).not.toBe(before);
		p.click();
		expect(calls.pause).toBe(1);
		expect(d(p)).toBe(before);
	});

	test("speed cycles 1× → 1.25× → 1.5× → 2× → 0.75× → 1×", () => {
		const { w, audio } = make({ copy: false });
		const s = q<HTMLButtonElement>(w, ".wd-audio-speed")!;
		expect(s.textContent).toBe("1×");
		const seen: number[] = [];
		for (let i = 0; i < 5; i++) {
			s.click();
			seen.push(audio.playbackRate);
		}
		expect(seen).toEqual([1.25, 1.5, 2, 0.75, 1]);
	});

	test("mute toggles audio.muted and the glyph", () => {
		const { w, audio } = make({ copy: false });
		const m = q<HTMLButtonElement>(w, ".wd-audio-mute")!;
		const before = d(m);
		const vc = () => audio.dispatchEvent(new win.Event("volumechange") as unknown as Event); // happy-dom does not fire it
		m.click();
		vc();
		expect(audio.muted).toBe(true);
		expect(d(m)).not.toBe(before);
		m.click();
		vc();
		expect(audio.muted).toBe(false);
		expect(d(m)).toBe(before);
	});

	test("seek input moves currentTime and --p", () => {
		const { w, audio } = make({ copy: false });
		const seek = q<HTMLInputElement>(w, ".wd-audio-seek")!;
		seek.value = "500";
		seek.dispatchEvent(new win.Event("input") as unknown as Event);
		expect(audio.currentTime).toBe(50);
		expect(seek.style.getPropertyValue("--p")).toBe("50%");
	});

	test("an audio error calls onError", () => {
		let n = 0;
		const { w, audio } = make({ copy: false, onError: () => n++ });
		audio.dispatchEvent(new win.Event("error") as unknown as Event);
		expect(n).toBe(1);
		disposeAudioPlayer(w);
		audio.dispatchEvent(new win.Event("error") as unknown as Event);
		expect(n).toBe(1);
	});

	describe("download", () => {
		test("locks while in flight, then check + done for a moment", async () => {
			let calls = 0;
			let release!: () => void;
			const { w } = make({ copy: false, onDownload: () => (calls++, new Promise<void>((r) => (release = r))) });
			const b = q<HTMLButtonElement>(w, ".wd-audio-download")!;
			const before = d(b);
			b.click();
			b.click();
			expect(calls).toBe(1);
			expect(b.disabled).toBe(true);
			release();
			await tick();
			expect(b.disabled).toBe(false);
			expect(d(b)).not.toBe(before);
			expect(b.classList.contains("done")).toBe(true);
		});
		test("a cancelled dialog (false) stays silent", async () => {
			const fb: string[] = [];
			const { w } = make({ copy: false, onFeedback: (t) => fb.push(t), onDownload: async () => false });
			const b = q<HTMLButtonElement>(w, ".wd-audio-download")!;
			const before = d(b);
			b.click();
			await tick();
			expect(d(b)).toBe(before);
			expect(b.classList.contains("done")).toBe(false);
			expect(fb).toEqual([]);
		});
		test("an error is fed back as a failure and unlocks", async () => {
			const fb: [string, boolean][] = [];
			const { w } = make({ copy: false, onFeedback: (t, ok) => fb.push([t, ok]), onDownload: () => Promise.reject(new Error("x")) });
			const b = q<HTMLButtonElement>(w, ".wd-audio-download")!;
			b.click();
			await tick();
			expect(fb.length).toBe(1);
			expect(fb[0][1]).toBe(false);
			expect(b.disabled).toBe(false);
		});
	});

	describe("copy", () => {
		test("locks while in flight, shows a check and feeds back ok", async () => {
			let calls = 0;
			let release!: (r: "ok") => void;
			const fb: [string, boolean][] = [];
			const { w } = make({
				copy: true,
				download: false,
				onFeedback: (t, ok) => fb.push([t, ok]),
				onCopy: () => (calls++, new Promise<"ok">((r) => (release = r))),
			});
			const b = q<HTMLButtonElement>(w, ".wd-audio-copy")!;
			const before = d(b);
			b.click();
			b.click();
			expect(calls).toBe(1);
			expect(b.disabled).toBe(true);
			release("ok");
			await tick();
			expect(b.disabled).toBe(false);
			expect(d(b)).not.toBe(before);
			expect(fb.map((f) => f[1])).toEqual([true]);
		});
		test("a failed copy feeds back an error and keeps the icon", async () => {
			const fb: [string, boolean][] = [];
			const { w } = make({ copy: true, download: false, onFeedback: (t, ok) => fb.push([t, ok]), onCopy: async () => "error" });
			const b = q<HTMLButtonElement>(w, ".wd-audio-copy")!;
			const before = d(b);
			b.click();
			await tick();
			expect(fb.map((f) => f[1])).toEqual([false]);
			expect(d(b)).toBe(before);
			expect(b.disabled).toBe(false);
		});
		test("a rejected copy feeds back an error", async () => {
			const fb: boolean[] = [];
			const { w } = make({ copy: true, download: false, onFeedback: (_t, ok) => fb.push(ok), onCopy: () => Promise.reject(new Error("x")) });
			q<HTMLButtonElement>(w, ".wd-audio-copy")!.click();
			await tick();
			expect(fb).toEqual([false]);
		});
	});

	describe("keyboard", () => {
		test("Space toggles, prevents default, ignores repeat", () => {
			const { w, calls } = make({ copy: false });
			const e = key(w, { code: "Space", key: " " });
			expect(e.defaultPrevented).toBe(true);
			expect(calls.play).toBe(1);
			key(w, { code: "Space", key: " ", repeat: true });
			expect(calls.play + calls.pause).toBe(1);
			key(w, { code: "Space", key: " " });
			expect(calls.pause).toBe(1);
		});
		test("Space on a text input is ignored", () => {
			const { w, calls } = make({ copy: false });
			const input = document.createElement("input");
			input.type = "text";
			w.append(input);
			key(w, { code: "Space", key: " " }, input as unknown as HTMLElement);
			expect(calls.play).toBe(0);
		});
		test("Arrow keys seek ±5s, clamped, and skip <input>", () => {
			const { w, audio } = make({ copy: false });
			audio.currentTime = 3;
			key(w, { code: "ArrowLeft", key: "ArrowLeft" });
			expect(audio.currentTime).toBe(0);
			key(w, { code: "ArrowRight", key: "ArrowRight" });
			expect(audio.currentTime).toBe(5);
			audio.currentTime = 98;
			key(w, { code: "ArrowRight", key: "ArrowRight" });
			expect(audio.currentTime).toBe(100);
			const seek = q<HTMLInputElement>(w, ".wd-audio-seek")!;
			audio.currentTime = 50;
			const e = key(w, { code: "ArrowRight", key: "ArrowRight" }, seek as unknown as HTMLElement);
			expect(e.defaultPrevented).toBe(false);
			expect(audio.currentTime).toBe(50);
		});
		test("KeyM toggles mute", () => {
			const { w, audio } = make({ copy: false });
			key(w, { code: "KeyM", key: "m" });
			expect(audio.muted).toBe(true);
			key(w, { code: "KeyM", key: "m" });
			expect(audio.muted).toBe(false);
		});
		test("Space on a focused button does not double-toggle", () => {
			const { w, calls } = make({ copy: false });
			const playBtn = q<HTMLButtonElement>(w, ".wd-audio-play")!;
			const e = key(w, { code: "Space", key: " " }, playBtn);
			expect(e.defaultPrevented).toBe(false);
			expect(calls.play).toBe(0);
		});
		test("non-finite duration or currentTime paints 0:00 and still clamps seek", () => {
			const { w, audio } = make({ copy: false });
			let ct = Number.NaN;
			Object.defineProperty(audio, "duration", { get: () => Number.NaN, configurable: true });
			Object.defineProperty(audio, "currentTime", { get: () => ct, set: (n: number) => (ct = n), configurable: true });
			audio.dispatchEvent(new win.Event("timeupdate") as unknown as Event);
			expect(q<HTMLInputElement>(w, ".wd-audio-seek")!.value).toBe("0");
			expect(q(w, ".wd-audio-time")!.textContent).toBe("0:00 / 0:00");
			Object.defineProperty(audio, "duration", { get: () => Number.POSITIVE_INFINITY, configurable: true });
			key(w, { code: "ArrowRight", key: "ArrowRight" });
			expect(audio.currentTime).toBe(5);
		});
		test("playing state switches play button to closed filled pause bars", () => {
			const { w } = make({ copy: false });
			const playBtn = q<HTMLButtonElement>(w, ".wd-audio-play")!;
			playBtn.click();
			expect(w.classList.contains("playing")).toBe(true);
			expect(d(playBtn)).toContain("z");
		});
	});

	test("disposeAudioPlayer pauses and ignores completions that land afterwards", async () => {
		const fb: unknown[] = [];
		let release!: () => void;
		const { w, calls } = make({
			copy: false,
			onFeedback: (...a) => fb.push(a),
			onDownload: () => new Promise<void>((r) => (release = r)),
		});
		q<HTMLButtonElement>(w, ".wd-audio-play")!.click();
		const b = q<HTMLButtonElement>(w, ".wd-audio-download")!;
		const before = d(b);
		b.click();
		disposeAudioPlayer(w);
		expect(calls.pause).toBe(1);
		release();
		await tick();
		expect(d(b)).toBe(before);
		expect(b.classList.contains("done")).toBe(false);
		key(w, { code: "Space", key: " " });
		expect(calls.play).toBe(1);
		expect(fb).toEqual([]);
	});
});
