/**
 * The video player of a message and of the file preview: the page's own controls over a bare <video>, and a full
 * screen of its own.
 *
 * The phone app runs in an Android WebView, and wry's `RustWebChromeClient` there cancels HTML5 video fullscreen
 * (`onShowCustomView` hides the custom view again instead of showing it), so the native player's fullscreen button does
 * nothing on a phone, and the Fullscreen API is not available in a WebView either. So the native controls are off and
 * the player draws its own bar (play, time, seek, mute, full screen). "Full screen" fills the viewport with CSS: it is the
 * same <video> element, so playback carries on. The look is in `app.css` (`.wd-video*`), one place for every caller.
 *
 * The player leaves the message while it is open (a transformed ancestor would otherwise trap `position: fixed`) and goes
 * back to where the message drew it on close.
 */
import { backLayer } from "./dialog";
import { t } from "./i18n";
import { ICON_PATHS } from "./icons";

type Shown = {
	wrap: HTMLDivElement;
	/** where the message drew the player: it goes back there on close */
	mark: Comment;
	flow: () => void;
	key: (e: KeyboardEvent) => void;
	/** the body overflow the page had before the video hid it */
	overflow: string;
};

/** At most one player owns the screen. */
let shown: Shown | null = null;

/** How long the bar stays after the last touch or move while the video plays. */
const IDLE_MS = 2500;

/** Shapes the line icons lack. Drawn with the same stroke as `ICON_PATHS` (see `.wd-video svg`). */
const PLAYER_PATHS = {
	play: "M8 5.5v13l10.5-6.5z",
	pause: "M8.5 5.5v13M15.5 5.5v13",
	volume: "M11 5 6.5 9H3.5v6h3L11 19zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12",
	muted: "M11 5 6.5 9H3.5v6h3L11 19zM16 9.5l5 5M21 9.5l-5 5",
} as const;

type Glyph = keyof typeof PLAYER_PATHS | "expand" | "shrink";

function glyph(name: Glyph): string {
	return name === "expand" || name === "shrink" ? ICON_PATHS[name] : PLAYER_PATHS[name];
}

function svg(name: Glyph): SVGSVGElement {
	const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	el.setAttribute("viewBox", "0 0 24 24");
	el.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", glyph(name));
	el.append(path);
	return el;
}

function setGlyph(button: HTMLElement, name: Glyph) {
	button.querySelector("path")?.setAttribute("d", glyph(name));
}

function button(className: string, name: Glyph, onpress: () => void): HTMLButtonElement {
	const el = document.createElement("button");
	el.type = "button";
	el.className = `wd-video-btn ${className} tap`;
	el.append(svg(name));
	el.addEventListener("click", onpress);
	return el;
}

function label(el: HTMLElement, text: string) {
	el.setAttribute("aria-label", text);
	el.title = text;
}

/** The speeds the speed button steps through, one tap at a time. */
export const SPEEDS = [1, 1.25, 1.5, 2, 0.5] as const;

/** The speed after `rate`: the next one in `SPEEDS`, and back to 1× after the last (an unknown rate also goes to 1×). */
export function nextSpeed(rate: number): number {
	const i = SPEEDS.indexOf(rate as (typeof SPEEDS)[number]);
	return i < 0 ? 1 : SPEEDS[(i + 1) % SPEEDS.length];
}

/** 1 → "1×", 1.25 → "1.25×" */
export function speedLabel(rate: number): string {
	return `${rate}×`;
}

/** 83 → "1:23", 3725 → "1:02:05" */
export function clock(seconds: number): string {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The video as a message shows it: a bare <video> under the page's own bar. */
export function videoPlayer(src: string): HTMLDivElement {
	const wrap = document.createElement("div");
	wrap.className = "wd-video-wrap";
	const video = document.createElement("video");
	video.src = src;
	video.controls = false;
	video.preload = "metadata";
	video.playsInline = true;
	video.className = "wd-video";

	const bar = document.createElement("div");
	bar.className = "wd-video-bar";
	const play = button("wd-video-play", "play", () => toggle());
	const time = document.createElement("span");
	time.className = "wd-video-time";
	const seek = document.createElement("input");
	seek.type = "range";
	seek.className = "wd-video-seek";
	seek.min = "0";
	seek.max = "1000";
	seek.step = "1";
	seek.value = "0";
	label(seek, t("재생 위치"));
	const speed = document.createElement("button");
	speed.type = "button";
	speed.className = "wd-video-btn wd-video-speed tap";
	speed.addEventListener("click", () => (video.playbackRate = nextSpeed(video.playbackRate)));
	const coarse = () => matchMedia("(pointer: coarse)").matches;
	// on a touch screen (no hover) a tap on the speaker opens the vertical slider instead of muting; 0 is mute there
	const mute = button("wd-video-mute", "volume", () => {
		if (coarse()) volBox.classList.toggle("open");
		else video.muted = !video.muted;
	});
	const full = button("wd-video-full", "expand", () => (shown?.wrap === wrap ? closeVideoView(wrap) : expand(wrap)));
	// the slider shares the seek bar's look (`.wd-video-seek`); `.wd-video-vol` only sizes it
	const vol = document.createElement("input");
	vol.type = "range";
	vol.className = "wd-video-seek wd-video-vol";
	vol.min = "0";
	vol.max = "1";
	vol.step = "0.05";
	label(vol, t("볼륨"));
	vol.addEventListener("input", () => {
		video.volume = Number(vol.value);
		video.muted = video.volume === 0;
	});
	const volBox = document.createElement("div");
	volBox.className = "wd-video-volbox";
	// on desktop the pop is transparent to layout (`display: contents`); on touch it is the vertical popup
	const volPop = document.createElement("div");
	volPop.className = "wd-video-volpop";
	volPop.append(vol);
	volBox.append(mute, volPop);
	bar.append(play, time, seek, speed, volBox, full);
	wrap.append(video, bar);

	// ── state → bar
	let dragging = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const toggle = () => {
		if (video.paused || video.ended) void video.play().catch(() => {});
		else video.pause();
	};
	const wake = () => {
		wrap.classList.remove("idle");
		clearTimeout(idle);
		// a paused video keeps its bar; a playing one hides it a moment after the last touch
		if (!video.paused && !dragging) {
			idle = setTimeout(() => {
				wrap.classList.add("idle");
				volBox.classList.remove("open");
			}, IDLE_MS);
		}
	};
	const paint = () => {
		const d = video.duration;
		const known = Number.isFinite(d) && d > 0;
		if (!dragging) seek.value = known ? String(Math.round((video.currentTime / d) * 1000)) : "0";
		seek.style.setProperty("--p", `${Number(seek.value) / 10}%`);
		time.textContent = `${clock(video.currentTime)} / ${clock(known ? d : 0)}`;
	};
	const sync = () => {
		const playing = !video.paused && !video.ended;
		setGlyph(play, playing ? "pause" : "play");
		label(play, playing ? t("일시정지") : t("재생"));
		setGlyph(mute, video.muted || video.volume === 0 ? "muted" : "volume");
		label(mute, video.muted ? t("소리 켜기") : t("음소거"));
		const level = video.muted ? 0 : video.volume;
		vol.value = String(level);
		vol.style.setProperty("--p", `${level * 100}%`);
		speed.textContent = speedLabel(video.playbackRate);
		label(speed, t("재생 속도"));
		const open = shown?.wrap === wrap;
		setGlyph(full, open ? "shrink" : "expand");
		label(full, open ? t("전체 화면 닫기") : t("전체 화면"));
		wrap.classList.toggle("playing", playing);
		wake();
	};
	label(full, t("전체 화면"));
	for (const ev of ["play", "pause", "ended", "volumechange", "ratechange", "emptied"]) video.addEventListener(ev, sync);
	for (const ev of ["timeupdate", "durationchange", "loadedmetadata", "seeked"]) video.addEventListener(ev, paint);
	video.addEventListener("click", () => {
		// the first tap on a hidden bar only brings it back
		if (wrap.classList.contains("idle")) wake();
		else toggle();
	});
	video.addEventListener("dblclick", () => (shown?.wrap === wrap ? closeVideoView(wrap) : expand(wrap)));
	wrap.addEventListener("pointermove", wake);
	wrap.addEventListener("pointerdown", (e) => {
		if (!volBox.contains(e.target as Node)) volBox.classList.remove("open");
		wake();
	});
	wrap.addEventListener("focusin", wake);
	seek.addEventListener("pointerdown", () => (dragging = true));
	const drop = () => {
		dragging = false;
		wake();
	};
	seek.addEventListener("pointerup", drop);
	seek.addEventListener("pointercancel", drop);
	seek.addEventListener("input", () => {
		const d = video.duration;
		if (Number.isFinite(d) && d > 0) video.currentTime = (Number(seek.value) / 1000) * d;
		paint();
	});
	// the bar follows the full screen state: expand/close call this after they change it
	wrap.addEventListener("wd-video-state", sync);
	paint();
	sync();
	return wrap;
}

function expand(wrap: HTMLDivElement) {
	closeVideoView(); // one at a time
	const mark = document.createComment("video");
	wrap.replaceWith(mark);
	wrap.classList.add("open");
	// the page behind stays put while the video has the screen
	const overflow = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	document.body.append(wrap);
	// Esc and the phone's back button both leave (dialog.ts owns the history entry a back press takes). Esc is taken in
	// the capture phase: the app's own Escape ("stop the agent") listens on the window and must not act here.
	const key = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
		e.preventDefault();
		closeVideoView(wrap);
	};
	window.addEventListener("keydown", key, true);
	const flow = backLayer({ onclose: () => closeVideoView(wrap) });
	shown = { wrap, mark, flow, key, overflow };
	wrap.dispatchEvent(new Event("wd-video-state"));
	wrap.querySelector<HTMLElement>(".wd-video-full")?.focus({ preventScroll: true });
}

/**
 * Put the player back in the message. Called with a player when that player's message goes away (a session switch
 * while it is on screen), and without one for the back button and Esc.
 */
export function closeVideoView(wrap?: HTMLDivElement) {
	const it = shown;
	if (!it || (wrap && it.wrap !== wrap)) return;
	shown = null;
	it.flow();
	window.removeEventListener("keydown", it.key, true);
	it.wrap.classList.remove("open");
	document.body.style.overflow = it.overflow;
	// back where the message drew it, unless the message was re-rendered meanwhile (then it is gone for good)
	if (it.mark.isConnected) it.mark.replaceWith(it.wrap);
	else it.wrap.remove();
	it.wrap.dispatchEvent(new Event("wd-video-state"));
	it.wrap.querySelector<HTMLElement>(".wd-video-full")?.focus({ preventScroll: true });
}
