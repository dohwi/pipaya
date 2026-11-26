<script lang="ts">
	// what had focus before this opened (captured before any child focuses itself): where focus returns on close
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	import { modalLayer, topLayer } from "../../lib/dialog";
	let lb: HTMLElement | undefined = $state();
	import { t } from "../../lib/i18n";
	import { fadeIn, fadeOut } from "../../lib/motion";
	import Icon from "../ui/Icon.svelte";
	import { app } from "../../lib/store.svelte";
	import { saveFile, sourceBlob } from "../../lib/save-file";
	import { copyFile, copyImage, fileCopyMessage, supportsFileClipboard } from "../../lib/clipboard";
	import { controlVideoPlayer, disposeVideoPlayer, readVideoState, videoPlayer } from "../../lib/video-view";
	import { errorText } from "../../lib/api";
	import { onDestroy } from "svelte";
	import type { ViewerImage } from "../../lib/store/ui-overlay.svelte";
	import { released } from "../../lib/pointer";
	import { isDesktopTauri } from "../../lib/tauri";

	/** Full-screen media viewer: zoom, pan, step through the images and videos of one message, copy, save. */
	let { onclose }: { onclose: () => void } = $props();

	const set = $derived(app.viewer);
	const img = $derived(set ? set.images[set.index] : null);
	const many = $derived((set?.images.length ?? 0) > 1);
	const isVideo = $derived(img?.kind === "video");
	const mixed = $derived(!!set?.images.some((m) => m.kind === "video"));
	/** The video bar is hidden (playing, no pointer): the viewer's own chrome fades with it. */
	let chromeIdle = $state(false);
	let videoStage = $state<HTMLElement | undefined>();
	let activeVideoWrap = $state<HTMLDivElement | null>(null);
	/** Full-screen (true OS fullscreen where available + edge-to-edge immersive layout). */
	let fullscreen = $state(false);
	/** Only OS fullscreen entered by this viewer is released on exit/close; an app window already in F11 stays untouched. */
	let enteredOsFs: "dom" | "tauri" | null = null;
	let fsRelease: Promise<void> = Promise.resolve();
	let fsExitedAt = 0;
	let fsSeq = 0;
	let destroyed = false;
	/** In image fullscreen, fade chrome after idle just like playing video. */
	const IMAGE_IDLE_MS = 2200;
	let imageIdle = $state(false);
	let imageIdleTimer: ReturnType<typeof setTimeout> | undefined;
	const hideChrome = $derived((isVideo && chromeIdle) || (!isVideo && fullscreen && imageIdle));

	async function releaseOsFullscreen(which: "dom" | "tauri" | null) {
		if (which === "dom") {
			if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
		} else if (which === "tauri") {
			try {
				const win = (await import("@tauri-apps/api/window")).getCurrentWindow();
				await win.setFullscreen(false);
			} catch {
				/* ignore */
			}
		}
	}

	function scheduleImageIdle() {
		clearTimeout(imageIdleTimer);
		imageIdle = false;
		if (!fullscreen || isVideo || destroyed) return;
		imageIdleTimer = setTimeout(() => {
			if (fullscreen && !isVideo && !destroyed) imageIdle = true;
		}, IMAGE_IDLE_MS);
	}

	async function enterFullscreen() {
		if (fullscreen) return;
		const seq = ++fsSeq;
		fullscreen = true;
		scheduleImageIdle();
		await fsRelease;
		if (seq !== fsSeq || destroyed || !app.viewer) return;
		try {
			if (isDesktopTauri()) {
				const win = (await import("@tauri-apps/api/window")).getCurrentWindow();
				if (seq !== fsSeq || destroyed || !app.viewer) return;
				if (!(await win.isFullscreen())) {
					await win.setFullscreen(true);
					if (seq === fsSeq && !destroyed && app.viewer) enteredOsFs = "tauri";
					else await win.setFullscreen(false).catch(() => {});
				}
			} else if (lb && !document.fullscreenElement && typeof lb.requestFullscreen === "function") {
				await lb.requestFullscreen();
				if (seq === fsSeq && !destroyed && app.viewer) enteredOsFs = "dom";
				else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
			}
		} catch {
			/* Fullscreen API denied or unsupported (e.g. iOS WebView): keep edge-to-edge `.lb.fs` view */
		}
	}

	function exitFullscreen() {
		const which = enteredOsFs;
		enteredOsFs = null;
		fullscreen = false;
		imageIdle = false;
		clearTimeout(imageIdleTimer);
		fsSeq++;
		if (which) fsRelease = fsRelease.then(() => releaseOsFullscreen(which));
		return fsRelease;
	}

	function toggleFullscreen() {
		void (fullscreen ? exitFullscreen() : enterFullscreen());
	}

	function closeViewer() {
		void exitFullscreen();
		onclose();
	}

	function onEscape() {
		// If the browser's own Esc just exited DOM fullscreen, don't let the same keypress also close the viewer
		if (performance.now() - fsExitedAt < 120) return;
		// Esc mirrors native fullscreen: exit fullscreen first, then close the viewer on the second Esc
		if (fullscreen) {
			void exitFullscreen();
			return;
		}
		closeViewer();
	}

	$effect(() => {
		if (!set) return;
		const onFsChange = () => {
			if (!document.fullscreenElement && enteredOsFs === "dom") {
				enteredOsFs = null;
				fullscreen = false;
				imageIdle = false;
				clearTimeout(imageIdleTimer);
				fsExitedAt = performance.now();
			}
		};
		document.addEventListener("fullscreenchange", onFsChange);
		let stopTauriResize: (() => void) | undefined;
		let active = true;
		if (isDesktopTauri()) {
			void import("@tauri-apps/api/window")
				.then(async ({ getCurrentWindow }) => {
					if (!active) return;
					const win = getCurrentWindow();
					const unlisten = await win.onResized(async () => {
						if (!active || enteredOsFs !== "tauri") return;
						try {
							if (!(await win.isFullscreen()) && active && enteredOsFs === "tauri") {
								enteredOsFs = null;
								fullscreen = false;
								imageIdle = false;
								clearTimeout(imageIdleTimer);
							}
						} catch {
							/* ignore */
						}
					});
					if (active) stopTauriResize = unlisten;
					else unlisten();
				})
				.catch(() => {});
		}
		return () => {
			active = false;
			document.removeEventListener("fullscreenchange", onFsChange);
			stopTauriResize?.();
		};
	});

	$effect(() => {
		// Reset image idle timer when entering/leaving fullscreen or stepping to another slide
		void img;
		void isVideo;
		void fullscreen;
		if (fullscreen && !isVideo) scheduleImageIdle();
		else {
			clearTimeout(imageIdleTimer);
			imageIdle = false;
		}
	});

	$effect(() => {
		const cur = img;
		const host = videoStage;
		if (!cur || cur.kind !== "video" || !host) return;
		const initialState = cur.getVideoState?.() ?? undefined;
		const player = videoPlayer(cur.src, {
			mode: "lightbox",
			filename: cur.name,
			initialState,
			onExpand: () => toggleFullscreen(),
			onIdleChange: (v) => {
				if (activeVideoWrap === player) chromeIdle = v;
			},
		});
		host.replaceChildren(player);
		activeVideoWrap = player;
		return () => {
			const st = readVideoState(player);
			if (st) cur.syncVideoState?.(st);
			disposeVideoPlayer(player);
			player.remove();
			if (activeVideoWrap === player) activeVideoWrap = null;
			chromeIdle = false;
		};
	});
	/** Full-resolution blob URL loaded on demand while the inline preview is already on screen. */
	let fullSrc = $state<string | null>(null);
	/** In-flight full-resolution load shared between the effect and Save so clicking Save never triggers a duplicate fetch. */
	let fullPending: Promise<string | null> | null = null;
	const displaySrc = $derived(fullSrc ?? img?.src ?? "");
	$effect(() => {
		const cur = img;
		fullSrc = null;
		fullPending = null;
		if (!cur?.loadFull) return;
		const ctl = new AbortController();
		const req = cur
			.loadFull(ctl.signal)
			.then((url) => {
				if (!ctl.signal.aborted && url) fullSrc = url;
				return !ctl.signal.aborted && url ? url : null;
			})
			.catch(() => null);
		fullPending = req;
		return () => {
			ctl.abort();
			if (fullPending === req) fullPending = null;
		};
	});

	const MIN = 1;
	const MAX = 8;
	let scale = $state(1);
	let x = $state(0);
	let y = $state(0);
	let dragging = $state(false);
	let moved = false;
	let from = { x: 0, y: 0, px: 0, py: 0 };
	/** Active pointers, for two-finger pinch */
	const pts = new Map<number, { x: number; y: number }>();
	let pinch = 0;
	let pic = $state<HTMLImageElement | null>(null);

	function reset() {
		scale = 1;
		x = 0;
		y = 0;
	}

	function zoomTo(next: number, cx = 0, cy = 0) {
		next = Math.min(MAX, Math.max(MIN, next));
		// keep the point under the cursor fixed while the scale changes
		const k = next / scale;
		x = cx - (cx - x) * k;
		y = cy - (cy - y) * k;
		scale = next;
		if (scale === 1) {
			x = 0;
			y = 0;
		}
	}

	/** Pointer position relative to the centre of the stage */
	function rel(e: { clientX: number; clientY: number }, el: HTMLElement) {
		const r = el.getBoundingClientRect();
		return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
	}

	function onwheel(e: WheelEvent) {
		if (isVideo) return;
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines / pages -> pixels
		const dx = e.deltaX * unit;
		const dy = e.deltaY * unit;
		if (!e.ctrlKey && scale > 1 && (e.deltaX !== 0 || Math.abs(dy) < 40)) {
			// two-finger trackpad scroll while zoomed in: pan the picture
			x -= dx;
			y -= dy;
			return;
		}
		const p = rel(e, e.currentTarget as HTMLElement);
		// a trackpad pinch arrives as ctrl+wheel with small deltas: it needs a much larger factor than a mouse wheel
		zoomTo(scale * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)), p.x, p.y);
	}

	/** Long press on the picture (touch) copies it */
	const HOLD = 550;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let touched = false;
	const cancelHold = () => clearTimeout(holdTimer);

	/** Pointer events on the video player's controls belong to them; swipes on the backdrop or video surface still step slides. */
	const onVideoBar = (e: Event) => !!(e.target as Element | null)?.closest?.(".wd-video-bar, button, input");
	const onVideoWrap = (e: Event) => !!(e.target as Element | null)?.closest?.(".wd-video-wrap, button, input");
	let videoSwipe: { id: number; x: number; y: number } | null = null;

	function ondown(e: PointerEvent) {
		if (isVideo) {
			// the player owns its own controls; backdrop taps close, and horizontal swipes outside the bar step slides
			downOnBackdrop = !onVideoWrap(e);
			moved = false;
			videoSwipe = many && !onVideoBar(e) ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
			return;
		}
		touched = e.pointerType === "touch";
		cancelHold();
		if (touched && pts.size === 0 && overPicture(e)) {
			holdTimer = setTimeout(() => {
				if (moved || pts.size !== 1) return;
				moved = true; // the release after a long press is not a tap
				navigator.vibrate?.(15);
				void copy();
			}, HOLD);
		}
		downOnBackdrop = !overPicture(e);
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		moved = false;
		if (pts.size === 2) {
			pinch = dist();
			pinched = true;
		} else from = { x: e.clientX, y: e.clientY, px: x, py: y };
		// at fit size the picture follows the finger when there are others to swipe to
		dragging = scale > 1 || many;
	}

	/** A second finger touched during this gesture: it is a pinch, never a swipe. */
	let pinched = false;
	const SWIPE = 50;

	const dist = () => {
		const [a, b] = [...pts.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	function onmove(e: PointerEvent) {
		if (isVideo) {
			if (videoSwipe && videoSwipe.id === e.pointerId) {
				if (Math.hypot(e.clientX - videoSwipe.x, e.clientY - videoSwipe.y) > 8) moved = true;
			}
			return;
		}
		if (!pts.has(e.pointerId)) return;
		if (released(e)) return onup(e); // let go where no pointerup reached us: the picture stops following the pointer
		if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8 || pts.size > 1) cancelHold();
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pts.size === 2) {
			const d = dist();
			if (pinch) zoomTo(scale * (d / pinch));
			pinch = d;
			moved = true;
		} else if (scale > 1) {
			if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 3) moved = true;
			x = from.px + (e.clientX - from.x);
			y = from.py + (e.clientY - from.y);
		} else if (many && !pinched) {
			// at fit size the picture follows the finger sideways
			const dx = e.clientX - from.x;
			if (Math.abs(dx) > 3) moved = true;
			x = dx;
		}
	}

	function onup(e: PointerEvent) {
		if (isVideo) {
			if (videoSwipe && videoSwipe.id === e.pointerId) {
				const dx = e.clientX - videoSwipe.x;
				const dy = e.clientY - videoSwipe.y;
				videoSwipe = null;
				if (e.type === "pointerup" && many && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) {
					moved = true;
					step(dx < 0 ? 1 : -1);
				}
			}
			return;
		}
		const swipe = pts.size === 1 && !pinched && scale === 1 && many;
		cancelHold();
		pts.delete(e.pointerId);
		pinch = 0;
		dragging = false;
		if (swipe) {
			const dx = e.clientX - from.x;
			const dy = e.clientY - from.y;
			if (e.type === "pointerup" && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
			else x = 0;
		}
		if (pts.size === 0) pinched = false;
		if (pts.size === 1) {
			const [p] = [...pts.values()];
			from = { x: p.x, y: p.y, px: x, py: y };
		}
	}

	/** Double-click or double-tap: fit <-> 2.5x at that spot */
	function ondbl(e: MouseEvent) {
		if (isVideo) return;
		const p = rel(e, e.currentTarget as HTMLElement);
		if (scale > 1) reset();
		else zoomTo(2.5, p.x, p.y);
	}

	/** Where the last press started: a click only closes when it started and ended on the empty backdrop. */
	let downOnBackdrop = false;
	let wokeOnDown = false;

	function onbackdrop(e: MouseEvent) {
		if (wokeOnDown) {
			wokeOnDown = false;
			downOnBackdrop = false;
			return;
		}
		// the pointer is captured by the stage, so e.target is always the stage: look at what was actually hit
		if (downOnBackdrop && !moved && (isVideo ? !onVideoWrap(e) : !overPicture(e))) closeViewer();
		downOnBackdrop = false;
	}

	function overPicture(e: { clientX: number; clientY: number }) {
		const r = pic?.getBoundingClientRect();
		return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
	}

	function step(d: number) {
		if (!set || !many) return;
		app.viewer = { ...set, index: (set.index + d + set.images.length) % set.images.length };
		reset();
	}

	let savingTarget = $state<ViewerImage | null>(null);
	async function saveVideo(target: ViewerImage) {
		if (savingTarget === target) return;
		savingTarget = target;
		try {
			if (await saveFile(target.src, target.name || "video.mp4")) {
				if (img === target) notify(t("저장했습니다"), true);
			}
		} catch (e) {
			if (img === target) notify(`${t("저장하지 못했습니다")}: ${errorText(e)}`, false);
		} finally {
			if (savingTarget === target) savingTarget = null;
		}
	}
	async function save() {
		if (img?.kind === "video") return saveVideo(img);
		const target = img;
		const idx = set?.index ?? 0;
		const initialSrc = displaySrc;
		const pending = fullPending;
		if (!target || !initialSrc || savingTarget === target) return;
		savingTarget = target;
		try {
			// the full-resolution picture is still loading: wait for the in-flight request so the saved file is the original
			let src = initialSrc;
			if (!fullSrc && pending) {
				const loaded = await pending;
				if (loaded) src = loaded;
			}
			const blob = await sourceBlob(src);
			// the message's mime type can be a wildcard (images in Markdown): the real one is on the bytes
			const type = blob.type.startsWith("image/") ? blob.type : target.mimeType;
			const ext = type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9].*$/i, "") || "png";
			if (await saveFile(blob, target.name || `image-${idx + 1}.${ext}`)) {
				if (img === target) notify(t("저장했습니다"), true);
			}
		} catch (e) {
			if (img === target) notify(`${t("저장하지 못했습니다")}: ${errorText(e)}`, false);
		} finally {
			if (savingTarget === target) savingTarget = null;
		}
	}

	/** The app toasts sit under the viewer (z-index), so the result is shown here, over the picture or video */
	let note = $state<{ text: string; ok: boolean; n: number; top: number } | null>(null);
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let noteN = 0;
	const NOTE_H = 40;
	function notify(text: string, ok: boolean) {
		// just above the picture/video's top edge (follows zoom/pan); if it fills the height, the note stops under the top bar
		const r = (isVideo ? activeVideoWrap : pic)?.getBoundingClientRect();
		note = { text, ok, n: ++noteN, top: r ? r.top - NOTE_H - 10 : 0 };
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => (note = null), ok ? 2000 : 3000);
	}
	onDestroy(() => {
		destroyed = true;
		clearTimeout(noteTimer);
		clearTimeout(imageIdleTimer);
		cancelHold();
		void exitFullscreen();
	});

	let copyingTarget = $state<ViewerImage | null>(null);
	async function copyVideo() {
		const target = img;
		if (!target || target.kind !== "video" || !supportsFileClipboard() || copyingTarget === target) return;
		copyingTarget = target;
		try {
			const res = await copyFile(target.src, target.name || "video.mp4");
			if (img === target) {
				const msg = fileCopyMessage(res);
				notify(msg.text, msg.ok);
			}
		} catch {
			if (img === target) notify(t("복사하지 못했습니다"), false);
		} finally {
			if (copyingTarget === target) copyingTarget = null;
		}
	}

	async function copy() {
		if (isVideo) return copyVideo();
		const target = img;
		const src = displaySrc;
		if (!target || !src || copyingTarget === target) return;
		copyingTarget = target;
		try {
			const ok = await copyImage(src);
			if (img === target) notify(ok ? t("이미지를 복사했습니다") : t("복사하지 못했습니다"), ok);
		} finally {
			if (copyingTarget === target) copyingTarget = null;
		}
	}

	function wakeChrome() {
		if (isVideo && activeVideoWrap) activeVideoWrap.dispatchEvent(new Event("wd-video-wake"));
		else if (fullscreen && !isVideo) scheduleImageIdle();
	}

	function onViewerPointerDown() {
		if (fullscreen && hideChrome) {
			wokeOnDown = true;
			wakeChrome();
		} else {
			wokeOnDown = false;
			if (fullscreen && !isVideo) scheduleImageIdle();
		}
	}

	function onkey(e: KeyboardEvent) {
		// over the viewer only: a dialog opened on top of it (none today) would keep its own arrows
		if (topLayer() !== lb) return;
		// Ctrl/Cmd+C copies the picture (by physical key, so it works on a Korean layout too); a text selection keeps its own copy
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyC") {
			if (window.getSelection()?.toString()) return;
			e.preventDefault();
			e.stopPropagation();
			void copy();
			return;
		}
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName;
		const range = tag === "INPUT" && (target as HTMLInputElement).type === "range";
		const textInput = (tag === "INPUT" && !range) || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target?.isContentEditable);
		if (textInput) return;
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
		if (plain && e.code === "KeyF") {
			if (!e.repeat) toggleFullscreen();
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		const wrap = activeVideoWrap;
		if (isVideo && wrap && plain) {
			let handled = true;
			if (e.code === "Space" || e.key === " " || e.code === "KeyK") {
				if (!e.repeat) controlVideoPlayer(wrap, "toggle");
			} else if (e.code === "KeyM") {
				if (!e.repeat) controlVideoPlayer(wrap, "mute");
			} else if (e.code === "KeyJ") controlVideoPlayer(wrap, { seekBy: -10 });
			else if (e.code === "KeyL") controlVideoPlayer(wrap, { seekBy: 10 });
			else if (!range && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
				const d = e.key === "ArrowLeft" ? -1 : 1;
				if (many && !e.shiftKey) step(d);
				else controlVideoPlayer(wrap, { seekBy: d * 5 });
			} else handled = false;
			if (handled) {
				e.preventDefault(); // Space must not click a focused button or scroll
				e.stopPropagation();
				return;
			}
		}
		if (range && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
		if (e.key === "ArrowLeft") step(-1);
		else if (e.key === "ArrowRight") step(1);
		else if (!isVideo && (e.key === "+" || e.key === "=")) zoomTo(scale * 1.4);
		else if (!isVideo && e.key === "-") zoomTo(scale / 1.4);
		else if (!isVideo && e.key === "0") reset();
		else return;
		wakeChrome();
		e.stopPropagation();
	}

	function focus(node: HTMLElement) {
		node.focus();
	}
</script>

<!-- arrows / zoom keys work wherever focus is; Esc and the modal stack are the shared layer's (lib/dialog.ts) -->
<svelte:window onkeydowncapture={onkey} />

{#if img && set}
	<!-- Keys (arrows, +/-, Esc) are handled on the window in capture phase (onkey); pointer gestures live on the stage. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="lb" class:fs={fullscreen} class:is-video={isVideo} class:chrome-idle={hideChrome} bind:this={lb} role="dialog" aria-modal="true" aria-label={mixed ? t("미디어 보기") : t("이미지 보기")} tabindex="-1" onpointermove={wakeChrome} onpointerdown={onViewerPointerDown} onfocusin={wakeChrome} use:focus use:modalLayer={{ onclose: onEscape, opener }} in:fadeIn|global out:fadeOut|global>
		<div
			class="stage"
			class:pan={scale > 1}
			class:dragging
			class:video={isVideo}
			onclick={onbackdrop}
			onwheel={onwheel}
			onpointerdown={ondown}
			onpointermove={onmove}
			onpointerup={onup}
			onpointercancel={onup}
			ondblclick={ondbl}
			oncontextmenu={(e) => touched && e.preventDefault()}
		>
			{#key set.index}
				{#if isVideo}
					<div class="video-stage" bind:this={videoStage}></div>
				{:else}
					<img
						bind:this={pic}
						src={displaySrc}
						alt={t("첨부 이미지 {n}", { n: set.index + 1 })}
						draggable="false"
						style="transform: translate({x}px, {y}px) scale({scale})"
						class:snap={!dragging}
					/>
				{/if}
			{/key}
		</div>

		{#if note}
			{#key note.n}
				<div class="note" class:err={!note.ok} style="--note-top: {note.top}px" role="status" aria-live="polite">
					<Icon name={note.ok ? "check" : "x"} />{note.text}
				</div>
			{/key}
		{/if}

		<div class="bar top">
			{#if many}<span class="count mono">{set.index + 1} / {set.images.length}</span>{/if}
			{#if img.name}<span class="fname" title={img.name}>{img.name}</span>{/if}
			<span class="grow"></span>
			{#if !isVideo}
				<button class="ctl tap" onclick={() => zoomTo(scale / 1.4)} disabled={scale <= MIN} aria-label={t("축소")} title={t("축소") + " (-)"}>−</button>
				<button class="ctl tap pct mono" onclick={reset} aria-label={t("원래 크기로")} title={t("맞춤") + " (0)"}>{Math.round(scale * 100)}%</button>
				<button class="ctl tap" onclick={() => zoomTo(scale * 1.4)} disabled={scale >= MAX} aria-label={t("확대")} title={t("확대") + " (+)"}>+</button>
			{/if}
			{#if !isVideo || supportsFileClipboard()}
				<button class="ctl tap" onclick={copy} disabled={copyingTarget === img} aria-label={isVideo ? t("파일 복사") : t("이미지 복사")} title={(isVideo ? t("파일 복사") : t("이미지 복사")) + " (Ctrl+C)"}>
					<Icon name="copy" />
				</button>
			{/if}
			<button class="ctl tap" onclick={save} disabled={savingTarget === img} aria-label={t("저장")} title={t("저장")}>
				<Icon name="download" />
			</button>
			<button
				class="ctl tap"
				onclick={toggleFullscreen}
				aria-label={fullscreen ? t("전체 화면 닫기") : t("전체 화면")}
				title={(fullscreen ? t("전체 화면 닫기") : t("전체 화면")) + " (F)"}
			>
				<Icon name={fullscreen ? "shrink" : "expand"} />
			</button>
			<button class="ctl tap" onclick={closeViewer} aria-label={t("닫기")} title={t("닫기") + " (Esc)"}><Icon name="x" /></button>
		</div>

		{#if many && set.images.length <= 12}
			<div class="dots" aria-hidden="true">
				{#each set.images as _, i}<span class:on={i === set.index}></span>{/each}
			</div>
		{/if}

		{#if many}
			<button class="nav prev" onclick={() => step(-1)} aria-label={(isVideo || mixed ? t("이전 미디어") : t("이전 이미지"))} title={t("이전") + " (←)"}><Icon name="chevron-down" /></button>
			<button class="nav next" onclick={() => step(1)} aria-label={(isVideo || mixed ? t("다음 미디어") : t("다음 이미지"))} title={t("다음") + " (→)"}><Icon name="chevron-down" /></button>
		{/if}
	</div>
{/if}

<style>
	.lb {
		position: fixed;
		inset: 0;
		z-index: var(--z-lightbox);
		background: var(--lb-scrim);
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		outline: none;
	}
	.lb.fs {
		background: #000;
		-webkit-backdrop-filter: none;
		backdrop-filter: none;
	}
	.lb.fs .video-stage {
		padding: 0;
		width: 100%;
		height: 100%;
	}
	.lb.fs .stage > img {
		max-width: 100%;
		max-height: 100%;
		border-radius: 0;
	}
	/* video playback bar sits along the bottom edge in fullscreen, so hide dots there (top bar still shows N / M) */
	.lb.fs.is-video .dots {
		display: none;
	}
	.stage {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		overflow: hidden;
		touch-action: none;
		cursor: zoom-in;
	}
	.stage.video {
		cursor: default;
	}
	.video-stage {
		display: grid;
		place-items: center;
		/* clears the top bar (34px buttons + 2x12px padding + safe area) and the dots below, 16:9 and 9:16 alike */
		padding: calc(64px + var(--sat)) 0 calc(48px + var(--sab));
	}
	.stage.pan {
		cursor: grab;
	}
	.stage.dragging {
		cursor: grabbing;
	}
	img {
		max-width: min(96vw, 1800px);
		max-height: calc(var(--dvh) * 0.88);
		object-fit: contain;
		border-radius: var(--radius-sm);
		box-shadow: var(--lb-shadow);
		user-select: none;
		-webkit-user-drag: none;
		-webkit-touch-callout: none;
		will-change: transform;
	}
	img.snap {
		transition: transform var(--motion-fast) var(--ease);
	}
	.bar {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 12px;
		pointer-events: none;
	}
	.bar > * {
		pointer-events: auto;
	}
	.top {
		top: 0;
		padding-top: calc(12px + var(--sat));
		background: linear-gradient(to bottom, var(--lb-top-fade), transparent);
	}
	.grow {
		flex: 1;
		pointer-events: none;
	}
	.fname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--lb-ink);
	}
	/* the player's bar went idle: the viewer's chrome fades with it */
	.bar.top,
	.nav,
	.dots {
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.lb.chrome-idle .bar.top,
	.lb.chrome-idle .nav,
	.lb.chrome-idle .dots {
		opacity: 0;
		pointer-events: none;
	}
	.count {
		flex: none;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--lb-ink-dim);
	}
	.count + .fname {
		margin-left: 8px;
	}
	.ctl {
		display: grid;
		place-items: center;
		min-width: 34px;
		height: 34px;
		padding: 0 8px;
		font-size: var(--fs-xl);
		line-height: 1;
		color: var(--lb-ink);
		background: var(--lb-ctrl-bg);
		border-radius: var(--radius);
		transition: background var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.ctl:hover:not(:disabled) {
			background: var(--lb-ctrl-hover);
		}
	}
	.ctl:disabled {
		color: var(--lb-ink-dim); /* on the always-dark stage a dimmed ink, not a faded control */
	}
	.pct {
		min-width: 56px;
		font-size: var(--fs-xs);
	}
	.ctl :global(svg) {
		width: 18px;
		height: 18px;
		stroke-width: 1.8;
	}
	.note {
		position: absolute;
		left: 50%;
		/* above the picture, but never higher than just under the top bar (34px buttons + 2x12px padding) and the notch */
		top: max(calc(58px + env(safe-area-inset-top, 0px)), var(--note-top, 0px));
		translate: -50% 0;
		max-width: min(92vw, 560px);
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		font-size: var(--fs-md, 14px);
		color: var(--lb-ink);
		background: var(--lb-note-bg);
		border-radius: min(var(--radius-pill), 18px); /* a one-line note: a pill (18 = half its 36px height) */
		line-height: 20px;
		box-shadow: var(--lb-note-shadow);
		pointer-events: none;
		animation: note-in var(--motion-fast) var(--ease-std);
	}
	.note.err {
		background: var(--lb-note-err);
	}
	.note :global(svg) {
		flex: none;
		width: 18px;
		height: 18px;
		stroke-width: 2.2;
	}
	@keyframes note-in {
		from {
			opacity: 0;
			scale: 0.92;
		}
	}
	.dots {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(16px + var(--sab));
		display: flex;
		justify-content: center;
		gap: 4px;
		pointer-events: none;
	}
	.dots span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--lb-dot);
		transition: background var(--motion-fast) var(--ease-std), scale var(--motion-fast) var(--ease-std);
	}
	.dots span.on {
		background: var(--lb-ink);
		scale: 1.25;
	}
	.nav {
		position: absolute;
		top: 50%;
		translate: 0 -50%;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		color: var(--lb-ink);
		background: var(--lb-ctrl-bg);
		border-radius: 50%;
		transition: background var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.nav:hover {
			background: var(--lb-nav-hover);
		}
	}
	.nav :global(svg) {
		width: 22px;
		height: 22px;
		stroke-width: 2;
	}
	.prev {
		left: 16px;
	}
	.prev :global(svg) {
		rotate: 90deg;
	}
	.next {
		right: 16px;
	}
	.next :global(svg) {
		rotate: -90deg;
	}
	/* touch screens swipe; the arrow buttons would sit on top of the picture */
	@media (pointer: coarse) {
		.nav {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		img.snap {
			transition: none;
		}
	}
	/* touch: the 44px hit box fills the 4px gap edge to edge (height stays 44px) without covering a neighbour */
	@media (pointer: coarse) {
		.ctl.tap::after {
			width: calc(100% + 4px);
		}
	}
</style>
