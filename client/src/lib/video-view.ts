/**
 * A video on the whole screen, played by the page itself.
 *
 * The phone app runs in an Android WebView, and wry's `RustWebChromeClient` there cancels HTML5 video fullscreen
 * (`onShowCustomView` hides the custom view again instead of showing it), so the player's own fullscreen button does
 * nothing on a phone. The Fullscreen API is not available in a WebView either. So the player comes with a button of
 * ours that fills the viewport with CSS: it is the same <video> element, so playback carries on and the native
 * controls stay where the user expects them. Desktop browsers get the same button, so there is one way everywhere.
 *
 * The player leaves the message while it is open (a transformed ancestor would otherwise trap `position: fixed`), so
 * its open state is written as inline styles: the message's scoped rules no longer reach it.
 */
import { backLayer } from "./dialog";
import { t } from "./i18n";
import { ICON_PATHS, type IconName } from "./icons";

type Shown = {
	wrap: HTMLDivElement;
	/** where the message drew the player: it goes back there on close */
	mark: Comment;
	flow: () => void;
	key: (e: KeyboardEvent) => void;
	/** the body overflow the page had before the video hid it */
	overflow: string;
	/** the inline styles the player had before it took the screen, to put back on close */
	saved: Map<Element, string>;
};

/** At most one player owns the screen. */
let shown: Shown | null = null;

const FULL = {
	wrap: "position: fixed; inset: 0; z-index: var(--z-lightbox); margin: 0; max-width: none; max-height: none; background: #000; border-radius: 0;",
	// fixed too: a percentage size inside the wrapper would follow the video's own ratio rather than the viewport
	video: "position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; object-fit: contain; border-radius: 0;",
	button:
		"position: absolute; top: 8px; right: 8px; z-index: 1; display: grid; place-items: center; width: 32px; height: 32px; color: #fff; background: color-mix(in srgb, #000 55%, transparent); border-radius: var(--radius-control);",
	icon: "width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round;",
};

function icon(name: IconName): SVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", ICON_PATHS[name]);
	svg.append(path);
	return svg;
}

function button(className: string, name: IconName, label: string, onpress: () => void): HTMLButtonElement {
	const el = document.createElement("button");
	el.type = "button";
	el.className = `${className} tap`;
	el.setAttribute("aria-label", label);
	el.title = label;
	el.append(icon(name));
	el.addEventListener("click", onpress);
	return el;
}

/** The video as a message shows it: the player, our fullscreen button, and the button that leaves the screen. */
export function videoPlayer(src: string): HTMLDivElement {
	const wrap = document.createElement("div");
	wrap.className = "wd-video-wrap";
	const video = document.createElement("video");
	video.src = src;
	video.controls = true;
	video.preload = "metadata";
	video.playsInline = true;
	// The browser's own fullscreen button is a dead end on a phone: the player has one, ours, on every platform.
	video.setAttribute("controlslist", "nofullscreen");
	video.className = "wd-video";
	const open = button("wd-video-full", "expand", t("전체 화면"), () => expand(wrap));
	const close = button("wd-video-close", "x", t("닫기"), () => closeVideoView(wrap));
	wrap.append(video, open, close);
	return wrap;
}

function expand(wrap: HTMLDivElement) {
	closeVideoView(); // one at a time
	const video = wrap.querySelector("video");
	const open = wrap.querySelector<HTMLElement>(".wd-video-full");
	const close = wrap.querySelector<HTMLElement>(".wd-video-close");
	if (!video || !open || !close) return;
	const mark = document.createComment("video");
	wrap.replaceWith(mark);
	/** The open state is inline: the player has left the message, so the message's scoped rules no longer reach it. */
	const saved = new Map<Element, string>();
	const set = (el: Element, css: string) => {
		saved.set(el, el.getAttribute("style") ?? "");
		el.setAttribute("style", css);
	};
	set(wrap, FULL.wrap);
	set(video, FULL.video);
	set(open, `${FULL.button} display: none;`);
	set(close, FULL.button);
	for (const glyph of wrap.querySelectorAll("svg")) set(glyph, FULL.icon);
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
	shown = { wrap, mark, flow, key, overflow, saved };
	close.focus({ preventScroll: true });
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
	for (const [el, css] of it.saved) el.setAttribute("style", css);
	document.body.style.overflow = it.overflow;
	// back where the message drew it, unless the message was re-rendered meanwhile (then it is gone for good)
	if (it.mark.isConnected) it.mark.replaceWith(it.wrap);
	else it.wrap.remove();
	it.wrap.querySelector<HTMLElement>(".wd-video-full")?.focus({ preventScroll: true });
}
