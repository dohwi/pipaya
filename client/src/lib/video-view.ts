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
import { canInterceptCopyKey, copyFile, fileCopyMessage, supportsFileClipboard, type FileCopyResult } from "./clipboard";
import { backLayer, modalCount } from "./dialog";
import { t } from "./i18n";
import { ICON_PATHS } from "./icons";
import { saveFile } from "./save-file";

export interface VideoPlayerOptions {
	/** Original file name (e.g. "demo.mp4") used when copying the file to the desktop clipboard. */
	filename?: string;
	/** Custom copy handler override (mainly for tests or callers with custom blob loading). */
	onCopy?: () => Promise<FileCopyResult>;
	/**
	 * Save button: `true` (default) shows it in the bar and in full screen, `"fullscreen"` only in full screen (the caller
	 * already has a save button in its own header), `false` leaves it out.
	 */
	download?: boolean | "fullscreen";
	/** Custom save handler (tests, callers with their own blob loading). Resolve `false` when the user cancelled the dialog. */
	onDownload?: () => Promise<boolean | void>;
}

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

/** Copy-capable players currently mounted, managed by a single capture-phase Ctrl/Cmd+C listener. */
const copyHandlers = new Map<HTMLDivElement, () => void>();
let copyKeyAttached = false;

/** True while any video player is expanded to the CSS fullscreen overlay. */
export function isVideoFullscreen(): boolean {
	return shown !== null;
}

function detachCopyKeyIfEmpty() {
	if (copyKeyAttached && copyHandlers.size === 0 && typeof window !== "undefined") {
		window.removeEventListener("keydown", onInlineCopyKey, true);
		copyKeyAttached = false;
	}
}

function pruneDisconnectedPlayers() {
	for (const wrap of [...copyHandlers.keys()]) {
		if (!wrap.isConnected) copyHandlers.delete(wrap);
	}
	detachCopyKeyIfEmpty();
}

function onInlineCopyKey(e: KeyboardEvent) {
	pruneDisconnectedPlayers();
	if (shown || modalCount() > 0 || !canInterceptCopyKey(e)) return;
	const active = typeof document !== "undefined" ? document.activeElement : null;
	let target: (() => void) | null = null;
	for (const [wrap, run] of copyHandlers) {
		if (active && wrap.contains(active)) {
			target = run;
			break;
		}
	}
	if (!target) {
		for (const [wrap, run] of copyHandlers) {
			try {
				if (wrap.matches(":hover")) {
					target = run;
					break;
				}
			} catch {
				/* ignore environments without :hover support */
			}
		}
	}
	if (!target) return;
	e.preventDefault();
	e.stopPropagation();
	target();
}

function registerCopyHandler(wrap: HTMLDivElement, run: () => void) {
	pruneDisconnectedPlayers();
	copyHandlers.set(wrap, run);
	if (!copyKeyAttached && typeof window !== "undefined") {
		window.addEventListener("keydown", onInlineCopyKey, true);
		copyKeyAttached = true;
	}
}

/** How long the bar stays after the last touch or move while the video plays. */
const IDLE_MS = 2500;

/** Shapes the line icons lack. Drawn with the same stroke as `ICON_PATHS` (see `.wd-video svg`). */
const PLAYER_PATHS = {
	play: "M8 5.5v13l10.5-6.5z",
	pause: "M8.5 5.5v13M15.5 5.5v13",
	volume: "M11 5 6.5 9H3.5v6h3L11 19zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12",
	muted: "M11 5 6.5 9H3.5v6h3L11 19zM16 9.5l5 5M21 9.5l-5 5",
} as const;

type Glyph = keyof typeof PLAYER_PATHS | "expand" | "shrink" | "copy" | "download" | "check" | "x";

function glyph(name: Glyph): string {
	return name in PLAYER_PATHS ? PLAYER_PATHS[name as keyof typeof PLAYER_PATHS] : ICON_PATHS[name as "expand" | "shrink" | "copy" | "download" | "check" | "x"];
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
export function videoPlayer(src: string, opts?: VideoPlayerOptions): HTMLDivElement {
	const wrap = document.createElement("div");
	wrap.className = "wd-video-wrap";
	wrap.tabIndex = -1;
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
	const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
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

	const canCopy = Boolean(opts?.onCopy) || supportsFileClipboard();
	let copyBtn: HTMLButtonElement | null = null;
	let noteEl: HTMLDivElement | null = null;
	let copyIconTimer: ReturnType<typeof setTimeout> | undefined;
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let copying = false;

	const showNote = (text: string, ok: boolean) => {
		if (!noteEl) {
			noteEl = document.createElement("div");
			noteEl.className = "wd-video-note";
			noteEl.setAttribute("role", "status");
			noteEl.setAttribute("aria-live", "polite");
			wrap.append(noteEl);
		}
		noteEl.classList.toggle("err", !ok);
		noteEl.replaceChildren(svg(ok ? "check" : "x"), document.createTextNode(text));
		noteEl.classList.add("show");
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => {
			noteEl?.classList.remove("show");
		}, ok ? 2000 : 3000);
	};

	let disposed = false;

	const runCopy = async () => {
		if (!canCopy || copying || disposed) return;
		copying = true;
		if (copyBtn) copyBtn.disabled = true;
		try {
			const res = opts?.onCopy ? await opts.onCopy() : await copyFile(src, opts?.filename || "video.mp4");
			if (disposed) return;
			const msg = fileCopyMessage(res);
			if (res === "ok" && copyBtn) {
				setGlyph(copyBtn, "check");
				clearTimeout(copyIconTimer);
				copyIconTimer = setTimeout(() => {
					if (copyBtn) setGlyph(copyBtn, "copy");
				}, 1400);
			}
			showNote(msg.text, msg.ok);
		} catch {
			if (!disposed) showNote(t("복사하지 못했습니다"), false);
		} finally {
			copying = false;
			if (copyBtn) copyBtn.disabled = false;
		}
	};

	const canDownload = opts?.download !== false;
	let downloadBtn: HTMLButtonElement | null = null;
	let downloadIconTimer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;

	const runDownload = async () => {
		if (!canDownload || saving || disposed) return;
		saving = true;
		if (downloadBtn) downloadBtn.disabled = true;
		try {
			const res = opts?.onDownload ? await opts.onDownload() : await saveFile(src, opts?.filename || "video.mp4");
			if (disposed) return;
			// false = the save dialog was cancelled: nothing to report
			if (res !== false) {
				if (downloadBtn) {
					setGlyph(downloadBtn, "check");
					clearTimeout(downloadIconTimer);
					downloadIconTimer = setTimeout(() => {
						if (downloadBtn) setGlyph(downloadBtn, "download");
					}, 1400);
				}
				showNote(t("저장했습니다"), true);
			}
		} catch {
			if (!disposed) showNote(t("저장하지 못했습니다"), false);
		} finally {
			saving = false;
			if (downloadBtn) downloadBtn.disabled = false;
		}
	};

	const tools: HTMLButtonElement[] = [];
	if (canCopy) {
		copyBtn = button("wd-video-copy", "copy", () => void runCopy());
		label(copyBtn, t("파일 복사"));
		tools.push(copyBtn);
		registerCopyHandler(wrap, () => void runCopy());
	}
	if (canDownload) {
		downloadBtn = button("wd-video-download", "download", () => void runDownload());
		label(downloadBtn, t("저장"));
		tools.push(downloadBtn);
		if (opts?.download === "fullscreen") wrap.classList.add("dl-fullscreen-only");
	}
	bar.append(play, time, seek, speed, volBox, ...tools, full);
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
		const target = e.target as Element | null;
		if (target && !volBox.contains(target)) volBox.classList.remove("open");
		// Focus the player when clicking the video surface so Ctrl/Cmd+C immediately targets it.
		if (!target?.closest("button, input")) wrap.focus({ preventScroll: true });
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
	wrap.addEventListener("wd-video-dispose", () => {
		disposed = true;
		clearTimeout(idle);
		clearTimeout(copyIconTimer);
		clearTimeout(downloadIconTimer);
		clearTimeout(noteTimer);
	});
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
		if (canInterceptCopyKey(e)) {
			const copy = copyHandlers.get(wrap);
			if (copy) {
				e.preventDefault();
				e.stopPropagation();
				copy();
				return;
			}
		}
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
	else {
		it.wrap.remove();
		copyHandlers.delete(it.wrap);
		detachCopyKeyIfEmpty();
	}
	it.wrap.dispatchEvent(new Event("wd-video-state"));
	it.wrap.querySelector<HTMLElement>(".wd-video-full")?.focus({ preventScroll: true });
}

/** Detaches a player when its host unmounts: exits fullscreen if active, clears timers, and drops key listeners. */
export function disposeVideoPlayer(wrap: HTMLDivElement) {
	closeVideoView(wrap);
	wrap.dispatchEvent(new Event("wd-video-dispose"));
	copyHandlers.delete(wrap);
	detachCopyKeyIfEmpty();
}
