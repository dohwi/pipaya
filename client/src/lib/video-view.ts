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
import type { VideoPlaybackState } from "./store/ui-overlay.svelte";

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
	/**
	 * `"inline"` (default): the full player with copy / save / full screen. `"lightbox"`: playback controls only, for a
	 * host (the Lightbox) that draws the title, copy, save and close itself.
	 */
	mode?: "inline" | "lightbox";
	/** Inline: expand to a host's own viewer instead of the standalone full screen (`.open`). */
	onExpand?: () => void;
	/** Lightbox: playback state carried over from the inline player (time, rate, volume, muted, playing). */
	initialState?: VideoPlaybackState;
	/** Lightbox: the bar hid (`true`) or came back (`false`), so the host can fade its own chrome in step. */
	onIdleChange?: (idle: boolean) => void;
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

const videoOf = (wrap: HTMLElement): HTMLVideoElement | null => wrap.querySelector("video");

/** Unapplied seek targets (waiting for `loadedmetadata`) so closing before load never clobbers the inline position with 0. */
const pendingTimes = new WeakMap<HTMLElement, number>();
const pendingMetaCleanups = new WeakMap<HTMLElement, () => void>();
const disposedWraps = new WeakSet<HTMLElement>();

const clearPendingMeta = (wrap: HTMLElement) => {
	pendingMetaCleanups.get(wrap)?.();
	pendingMetaCleanups.delete(wrap);
	pendingTimes.delete(wrap);
};

const safePlay = (video: HTMLVideoElement) => {
	try {
		void Promise.resolve(video.play()).catch(() => {});
	} catch {
		/* no playback in this environment */
	}
};

const seekClamped = (video: HTMLVideoElement, time: number) => {
	if (!Number.isFinite(time)) return;
	const d = video.duration;
	video.currentTime = Math.max(0, Number.isFinite(d) && d > 0 ? Math.min(time, d) : time);
};

/** Snapshot of the player's playback state, or null when `wrap` holds no video. */
export function readVideoState(wrap: HTMLElement): VideoPlaybackState | null {
	const v = videoOf(wrap);
	if (!v) return null;
	const pending = pendingTimes.get(wrap);
	return {
		time: pending ?? (Number.isFinite(v.currentTime) ? v.currentTime : 0),
		rate: v.playbackRate,
		volume: v.volume,
		muted: v.muted,
		playing: !v.paused && !v.ended,
	};
}

/** Restore time, rate, volume and muted (not play / pause) onto the player; bad numbers are skipped or clamped. */
export function applyVideoState(wrap: HTMLElement, state: VideoPlaybackState) {
	if (disposedWraps.has(wrap) || !wrap.isConnected) return;
	const v = videoOf(wrap);
	if (!v) return;
	if (Number.isFinite(state.rate) && state.rate > 0) v.playbackRate = state.rate;
	if (Number.isFinite(state.volume)) v.volume = Math.min(1, Math.max(0, state.volume));
	v.muted = Boolean(state.muted);
	if (Number.isFinite(state.time)) {
		clearPendingMeta(wrap);
		if (v.readyState >= 1) {
			seekClamped(v, state.time);
		} else {
			const target = Math.max(0, state.time);
			pendingTimes.set(wrap, target);
			const onMeta = () => {
				clearPendingMeta(wrap);
				if (disposedWraps.has(wrap) || !wrap.isConnected) return;
				seekClamped(v, target);
			};
			v.addEventListener("loadedmetadata", onMeta, { once: true });
			pendingMetaCleanups.set(wrap, () => v.removeEventListener("loadedmetadata", onMeta));
		}
	}
}

/** Drive a player from outside (the Lightbox's keys): play / pause, mute, or a relative seek. Wakes the bar. */
export function controlVideoPlayer(wrap: HTMLElement, action: "toggle" | "mute" | { seekBy: number }) {
	const v = videoOf(wrap);
	if (!v) return;
	if (action === "toggle") {
		if (v.paused || v.ended) safePlay(v);
		else v.pause();
	} else if (action === "mute") v.muted = !v.muted;
	else if (Number.isFinite(action.seekBy)) {
		const d = v.duration;
		let next = (Number.isFinite(v.currentTime) ? v.currentTime : 0) + action.seekBy;
		if (Number.isFinite(d) && d > 0) next = Math.min(next, d);
		v.currentTime = Math.max(0, next);
	}
	wrap.dispatchEvent(new Event("wd-video-wake"));
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

	const lightbox = opts?.mode === "lightbox";
	if (lightbox) wrap.classList.add("lightbox-mode");
	const expandOrClose = () => {
		if (opts?.onExpand) opts.onExpand();
		else if (shown?.wrap === wrap) closeVideoView(wrap);
		else expand(wrap);
	};

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
	const full = button("wd-video-full", "expand", expandOrClose);
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

	const canCopy = !lightbox && (Boolean(opts?.onCopy) || supportsFileClipboard());
	let copyBtn: HTMLButtonElement | null = null;
	let topCopyBtn: HTMLButtonElement | null = null;
	let topDownloadBtn: HTMLButtonElement | null = null;
	const copyBtns = () => [copyBtn, topCopyBtn].filter((b): b is HTMLButtonElement => b !== null);
	const downloadBtns = () => [downloadBtn, topDownloadBtn].filter((b): b is HTMLButtonElement => b !== null);
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
		for (const b of copyBtns()) b.disabled = true;
		try {
			const res = opts?.onCopy ? await opts.onCopy() : await copyFile(src, opts?.filename || "video.mp4");
			if (disposed) return;
			const msg = fileCopyMessage(res);
			if (res === "ok" && copyBtns().length) {
				for (const b of copyBtns()) setGlyph(b, "check");
				clearTimeout(copyIconTimer);
				copyIconTimer = setTimeout(() => {
					for (const b of copyBtns()) setGlyph(b, "copy");
				}, 1400);
			}
			showNote(msg.text, msg.ok);
		} catch {
			if (!disposed) showNote(t("복사하지 못했습니다"), false);
		} finally {
			copying = false;
			for (const b of copyBtns()) b.disabled = false;
		}
	};

	const canDownload = !lightbox && opts?.download !== false;
	let downloadBtn: HTMLButtonElement | null = null;
	let downloadIconTimer: ReturnType<typeof setTimeout> | undefined;
	let saving = false;

	const runDownload = async () => {
		if (!canDownload || saving || disposed) return;
		saving = true;
		for (const b of downloadBtns()) b.disabled = true;
		try {
			const res = opts?.onDownload ? await opts.onDownload() : await saveFile(src, opts?.filename || "video.mp4");
			if (disposed) return;
			// false = the save dialog was cancelled: nothing to report
			if (res !== false) {
				if (downloadBtns().length) {
					for (const b of downloadBtns()) setGlyph(b, "check");
					clearTimeout(downloadIconTimer);
					downloadIconTimer = setTimeout(() => {
						for (const b of downloadBtns()) setGlyph(b, "download");
					}, 1400);
				}
				showNote(t("저장했습니다"), true);
			}
		} catch {
			if (!disposed) showNote(t("저장하지 못했습니다"), false);
		} finally {
			saving = false;
			for (const b of downloadBtns()) b.disabled = false;
		}
	};

	const tools: HTMLButtonElement[] = [];
	if (canCopy) {
		copyBtn = button("wd-video-copy", "copy", () => void runCopy());
		label(copyBtn, t("파일 복사"));
		tools.push(copyBtn);
		registerCopyHandler(wrap, () => void runCopy());
	}
	// standalone full screen (no host viewer): a title bar with copy / save / close, as the Lightbox draws its own
	if (!lightbox && !opts?.onExpand) {
		const top = document.createElement("div");
		top.className = "wd-video-top";
		const title = document.createElement("span");
		title.className = "wd-video-title";
		title.textContent = opts?.filename ?? "";
		if (opts?.filename) title.title = opts.filename;
		top.append(title);
		if (canCopy) {
			topCopyBtn = button("wd-video-top-btn wd-video-top-copy", "copy", () => void runCopy());
			label(topCopyBtn, t("파일 복사"));
			top.append(topCopyBtn);
		}
		if (canDownload) {
			topDownloadBtn = button("wd-video-top-btn wd-video-top-download", "download", () => void runDownload());
			label(topDownloadBtn, t("저장"));
			top.append(topDownloadBtn);
		}
		const topClose = button("wd-video-top-btn wd-video-top-close", "x", () => closeVideoView(wrap));
		label(topClose, t("닫기"));
		top.append(topClose);
		wrap.append(top);
	}
	if (canDownload) {
		downloadBtn = button("wd-video-download", "download", () => void runDownload());
		label(downloadBtn, t("저장"));
		tools.push(downloadBtn);
		if (opts?.download === "fullscreen") wrap.classList.add("dl-fullscreen-only");
	}
	if (lightbox) bar.append(play, time, seek, speed, volBox);
	else bar.append(play, time, seek, speed, volBox, ...tools, full);
	wrap.prepend(video, bar);

	// ── state → bar
	let dragging = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const toggle = () => {
		if (video.paused || video.ended) void video.play().catch(() => {});
		else video.pause();
	};
	let wasIdle = false;
	const setIdle = (v: boolean) => {
		if (disposed) return;
		wrap.classList.toggle("idle", v);
		if (v !== wasIdle) {
			wasIdle = v;
			opts?.onIdleChange?.(v);
		}
	};
	const wake = () => {
		if (disposed) return;
		setIdle(false);
		clearTimeout(idle);
		// a paused video keeps its bar; a playing one hides it a moment after the last touch
		if (!video.paused && !dragging) {
			idle = setTimeout(() => {
				if (disposed) return;
				setIdle(true);
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
	if (!lightbox) video.addEventListener("dblclick", expandOrClose);
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
	wrap.addEventListener("wd-video-wake", wake);
	wrap.addEventListener("wd-video-dispose", () => {
		disposed = true;
		disposedWraps.add(wrap);
		clearPendingMeta(wrap);
		clearTimeout(idle);
		clearTimeout(copyIconTimer);
		clearTimeout(downloadIconTimer);
		clearTimeout(noteTimer);
		try {
			video.pause();
		} catch {
			/* ignore */
		}
	});
	const start = opts?.initialState;
	if (lightbox && start) {
		video.playbackRate = Number.isFinite(start.rate) && start.rate > 0 ? start.rate : 1;
		video.volume = Number.isFinite(start.volume) ? Math.min(1, Math.max(0, start.volume)) : 1;
		video.muted = Boolean(start.muted);
		const target = Number.isFinite(start.time) ? Math.max(0, start.time) : 0;
		const finishStart = () => {
			clearPendingMeta(wrap);
			if (disposed) return;
			seekClamped(video, target);
			if (start.playing) safePlay(video);
		};
		if (video.readyState >= 1) {
			finishStart();
		} else {
			pendingTimes.set(wrap, target);
			video.addEventListener("loadedmetadata", finishStart, { once: true });
			pendingMetaCleanups.set(wrap, () => video.removeEventListener("loadedmetadata", finishStart));
		}
	}
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
		if (e.defaultPrevented || e.isComposing) return;
		if (canInterceptCopyKey(e)) {
			const copy = copyHandlers.get(wrap);
			if (copy) {
				e.preventDefault();
				e.stopPropagation();
				copy();
				return;
			}
		}
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName;
		const range = tag === "INPUT" && (target as HTMLInputElement).type === "range";
		const textInput = (tag === "INPUT" && !range) || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target?.isContentEditable);
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
		const is = (code: string) => e.code === code || e.key === code;
		if (is("Escape")) {
			e.preventDefault();
			e.stopPropagation();
			closeVideoView(wrap);
			return;
		}
		if (textInput || !plain) return;
		let handled = true;
		if (is("KeyF")) {
			if (!e.repeat) closeVideoView(wrap);
		} else if (is("KeyM")) {
			if (!e.repeat) controlVideoPlayer(wrap, "mute");
		} else if (is("KeyJ")) controlVideoPlayer(wrap, { seekBy: -10 });
		else if (is("KeyL")) controlVideoPlayer(wrap, { seekBy: 10 });
		else if (is("KeyK") || is("Space") || e.key === " ") {
			if (!e.repeat) controlVideoPlayer(wrap, "toggle");
		} else if (!range && is("ArrowLeft")) controlVideoPlayer(wrap, { seekBy: -5 });
		else if (!range && is("ArrowRight")) controlVideoPlayer(wrap, { seekBy: 5 });
		else handled = false;
		if (!handled) return;
		e.preventDefault();
		e.stopPropagation();
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
