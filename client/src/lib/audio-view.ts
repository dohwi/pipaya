/**
 * The audio player of a message and of the file preview: the page's own row of controls over a hidden <audio>, in the
 * theme's colours (the native controls cannot be themed and sit apart from the copy / save buttons). The look is in
 * `app.css` (`.wd-audio*`); the shapes and the speed / clock helpers are shared with `video-view.ts`.
 */
import { copyFile, fileCopyMessage, supportsFileClipboard, type FileCopyResult } from "./clipboard";
import { t } from "./i18n";
import { ICON_PATHS } from "./icons";
import { saveFile } from "./save-file";
import { clock, speedLabel } from "./video-view";

export interface AudioPlayerOptions {
	/** Original file name (e.g. "note.mp3"), used when copying or saving. */
	filename?: string;
	/** Save button (default `true`). */
	download?: boolean;
	/** Copy-file button (default: when the client can put a file on the clipboard). */
	copy?: boolean;
	/** Custom copy handler (tests, callers with their own blob loading). */
	onCopy?: () => Promise<FileCopyResult>;
	/** Custom save handler. Resolve `false` when the user cancelled the dialog. */
	onDownload?: () => Promise<boolean | void>;
	/** Outcome of a copy, and a failed save: the host shows it (toast). */
	onFeedback?: (text: string, ok: boolean) => void;
	/** The browser could not load or play the file. */
	onError?: () => void;
}

/** The speeds the speed button steps through. */
const AUDIO_SPEEDS = [1, 1.25, 1.5, 2, 0.75] as const;

const nextAudioSpeed = (rate: number): number => {
	const i = AUDIO_SPEEDS.indexOf(rate as (typeof AUDIO_SPEEDS)[number]);
	return i < 0 ? 1 : AUDIO_SPEEDS[(i + 1) % AUDIO_SPEEDS.length];
};

/** Same shapes as the video player's bar (closed filled bars for pause so both play and pause fill cleanly inside the circle). */
const PLAYER_PATHS = {
	play: "M8 5.5v13l10.5-6.5z",
	pause: "M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z",
	volume: "M11 5 6.5 9H3.5v6h3L11 19zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12",
	muted: "M11 5 6.5 9H3.5v6h3L11 19zM16 9.5l5 5M21 9.5l-5 5",
} as const;

type Glyph = keyof typeof PLAYER_PATHS | "copy" | "download" | "check";

const glyph = (name: Glyph): string => (name in PLAYER_PATHS ? PLAYER_PATHS[name as keyof typeof PLAYER_PATHS] : ICON_PATHS[name as "copy" | "download" | "check"]);

function svg(name: Glyph): SVGSVGElement {
	const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	el.setAttribute("viewBox", "0 0 24 24");
	el.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", glyph(name));
	el.append(path);
	return el;
}

const setGlyph = (button: HTMLElement, name: Glyph) => button.querySelector("path")?.setAttribute("d", glyph(name));

function button(className: string, name: Glyph, onpress: () => void): HTMLButtonElement {
	const el = document.createElement("button");
	el.type = "button";
	el.className = `wd-audio-btn ${className} tap`;
	el.append(svg(name));
	el.addEventListener("click", onpress);
	return el;
}

function label(el: HTMLElement, text: string) {
	el.setAttribute("aria-label", text);
	el.title = text;
}

const disposers = new WeakMap<HTMLElement, () => void>();

/** The audio as a message shows it: a hidden <audio> under the page's own row of controls. */
export function audioPlayer(src: string, opts?: AudioPlayerOptions): HTMLDivElement {
	const wrap = document.createElement("div");
	wrap.className = "wd-audio-wrap";
	wrap.tabIndex = 0;
	wrap.setAttribute("role", "group");
	wrap.setAttribute("aria-label", opts?.filename || t("오디오"));
	const audio = document.createElement("audio");
	audio.className = "wd-audio";
	audio.preload = "metadata";
	audio.controls = false;
	audio.src = src;

	let disposed = false;
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let downloadTimer: ReturnType<typeof setTimeout> | undefined;

	const safePlay = () => {
		try {
			void Promise.resolve(audio.play()).catch(() => {});
		} catch {
			/* no playback in this environment */
		}
	};
	const toggle = () => {
		if (audio.paused || audio.ended) safePlay();
		else audio.pause();
	};
	const seekBy = (delta: number) => {
		const d = audio.duration;
		const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
		let next = cur + delta;
		if (Number.isFinite(d) && d > 0) next = Math.min(next, d);
		audio.currentTime = Math.max(0, next);
	};

	const play = button("wd-audio-play", "play", toggle);
	const time = document.createElement("span");
	time.className = "wd-audio-time";
	const seek = document.createElement("input");
	seek.type = "range";
	seek.className = "wd-audio-seek";
	seek.min = "0";
	seek.max = "1000";
	seek.step = "1";
	seek.value = "0";
	seek.style.setProperty("--p", "0%");
	label(seek, t("재생 위치"));
	const speed = document.createElement("button");
	speed.type = "button";
	speed.className = "wd-audio-btn wd-audio-speed tap";
	speed.addEventListener("click", () => (audio.playbackRate = nextAudioSpeed(audio.playbackRate)));
	const mute = button("wd-audio-mute", "volume", () => (audio.muted = !audio.muted));

	const bar: HTMLElement[] = [play, time, seek, speed, mute];

	let copyBtn: HTMLButtonElement | null = null;
	let copying = false;
	const canCopy = opts?.copy ?? supportsFileClipboard();
	if (canCopy) {
		copyBtn = button("wd-audio-copy", "copy", () => void runCopy());
		label(copyBtn, t("파일 복사"));
		bar.push(copyBtn);
	}
	const runCopy = async () => {
		if (!copyBtn || copying || disposed) return;
		const btn = copyBtn;
		copying = true;
		btn.disabled = true;
		try {
			const res = opts?.onCopy ? await opts.onCopy() : await copyFile(src, opts?.filename || "audio.mp3");
			if (disposed) return;
			const msg = fileCopyMessage(res, res === "ok" ? opts?.filename : undefined);
			if (res === "ok") {
				setGlyph(btn, "check");
				clearTimeout(copyTimer);
				copyTimer = setTimeout(() => setGlyph(btn, "copy"), 1400);
			}
			opts?.onFeedback?.(msg.text, msg.ok);
		} catch {
			if (!disposed) opts?.onFeedback?.(fileCopyMessage("error").text, false);
		} finally {
			copying = false;
			btn.disabled = false;
		}
	};

	let downloadBtn: HTMLButtonElement | null = null;
	let saving = false;
	if (opts?.download !== false) {
		downloadBtn = button("wd-audio-download", "download", () => void runDownload());
		label(downloadBtn, t("저장"));
		bar.push(downloadBtn);
	}
	const runDownload = async () => {
		if (!downloadBtn || saving || disposed) return;
		const btn = downloadBtn;
		saving = true;
		btn.disabled = true;
		try {
			const res = opts?.onDownload ? await opts.onDownload() : await saveFile(src, opts?.filename || "audio.mp3");
			if (disposed) return;
			// false = the save dialog was cancelled: nothing to report
			if (res !== false) {
				setGlyph(btn, "check");
				btn.classList.add("done");
				clearTimeout(downloadTimer);
				downloadTimer = setTimeout(() => {
					setGlyph(btn, "download");
					btn.classList.remove("done");
				}, 1400);
			}
		} catch {
			if (!disposed) opts?.onFeedback?.(t("저장하지 못했습니다"), false);
		} finally {
			saving = false;
			btn.disabled = false;
		}
	};

	wrap.append(audio, ...bar);

	// ── state → controls
	let dragging = false;
	const paint = () => {
		const d = audio.duration;
		const known = Number.isFinite(d) && d > 0;
		const cur = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
		if (!dragging) seek.value = known ? String(Math.min(1000, Math.round((cur / d) * 1000))) : "0";
		seek.style.setProperty("--p", `${Number(seek.value) / 10}%`);
		time.textContent = `${clock(cur)} / ${clock(known ? d : 0)}`;
	};
	const sync = () => {
		const playing = !audio.paused && !audio.ended;
		setGlyph(play, playing ? "pause" : "play");
		label(play, playing ? t("일시정지") : t("재생"));
		const silent = audio.muted || audio.volume === 0;
		setGlyph(mute, silent ? "muted" : "volume");
		label(mute, audio.muted ? t("소리 켜기") : t("음소거"));
		speed.textContent = speedLabel(audio.playbackRate);
		label(speed, t("재생 속도"));
		wrap.classList.toggle("playing", playing);
	};
	for (const ev of ["play", "pause", "ended", "volumechange", "ratechange", "emptied"]) audio.addEventListener(ev, sync);
	for (const ev of ["timeupdate", "durationchange", "loadedmetadata", "seeked"]) audio.addEventListener(ev, paint);
	audio.addEventListener("error", () => {
		if (!disposed) opts?.onError?.();
	});
	const drop = () => {
		if (!dragging) return;
		dragging = false;
		window.removeEventListener("pointerup", drop);
		window.removeEventListener("pointercancel", drop);
		paint();
	};
	seek.addEventListener("pointerdown", () => {
		dragging = true;
		window.addEventListener("pointerup", drop);
		window.addEventListener("pointercancel", drop);
	});
	seek.addEventListener("pointerup", drop);
	seek.addEventListener("pointercancel", drop);
	seek.addEventListener("change", drop);
	seek.addEventListener("blur", drop);
	seek.addEventListener("input", () => {
		const d = audio.duration;
		if (Number.isFinite(d) && d > 0) audio.currentTime = (Number(seek.value) / 1000) * d;
		paint();
	});

	wrap.addEventListener("keydown", (e) => {
		if (disposed || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName;
		const isInput = tag === "INPUT";
		const range = isInput && (target as HTMLInputElement).type === "range";
		const textInput = (isInput && !range) || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target?.isContentEditable);
		if (textInput) return;
		const is = (code: string) => e.code === code || e.key === code;
		if (is("Space") || e.key === " ") {
			// a focused button turns Space into its own click
			if (tag === "BUTTON") return;
			e.preventDefault();
			if (!e.repeat) toggle();
		} else if (is("ArrowLeft") || is("ArrowRight")) {
			if (isInput) return;
			e.preventDefault();
			seekBy(is("ArrowLeft") ? -5 : 5);
		} else if (is("KeyM")) {
			e.preventDefault();
			if (!e.repeat) audio.muted = !audio.muted;
		}
	});

	disposers.set(wrap, () => {
		disposed = true;
		dragging = false;
		window.removeEventListener("pointerup", drop);
		window.removeEventListener("pointercancel", drop);
		clearTimeout(copyTimer);
		clearTimeout(downloadTimer);
		try {
			audio.pause();
		} catch {
			/* ignore */
		}
	});
	paint();
	sync();
	return wrap;
}

/** Detaches a player when its host unmounts: pauses, clears timers, and makes late completions do nothing. */
export function disposeAudioPlayer(wrap: HTMLElement) {
	disposers.get(wrap)?.();
}
