<script lang="ts">
	// what had focus before this opened (captured before any child focuses itself): where focus returns on close
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	import { modalLayer, topLayer } from "../lib/dialog";
	let lb: HTMLElement | undefined = $state();
	import { t } from "../lib/i18n";
	import { fadeIn, fadeOut } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import { app } from "../lib/store.svelte";
	import { saveFile, sourceBlob } from "../lib/save-file";
	import { copyImage } from "../lib/clipboard";
	import { errorText } from "../lib/api";
	import { onDestroy } from "svelte";

	/** Full-screen image viewer: zoom, pan, step through the images of one message, save. */
	let { onclose }: { onclose: () => void } = $props();

	const set = $derived(app.viewer);
	const img = $derived(set ? set.images[set.index] : null);
	const many = $derived((set?.images.length ?? 0) > 1);

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
		e.preventDefault();
		const p = rel(e, e.currentTarget as HTMLElement);
		zoomTo(scale * Math.exp(-e.deltaY * 0.0022), p.x, p.y);
	}

	/** Long press on the picture (touch) copies it */
	const HOLD = 550;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let touched = false;
	const cancelHold = () => clearTimeout(holdTimer);

	function ondown(e: PointerEvent) {
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
		if (!pts.has(e.pointerId)) return;
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
		const p = rel(e, e.currentTarget as HTMLElement);
		if (scale > 1) reset();
		else zoomTo(2.5, p.x, p.y);
	}

	/** Where the last press started: a click only closes when it started and ended on the empty backdrop. */
	let downOnBackdrop = false;

	function onbackdrop(e: MouseEvent) {
		// the pointer is captured by the stage, so e.target is always the stage: look at what was actually hit
		if (downOnBackdrop && !moved && !overPicture(e)) onclose();
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

	async function save() {
		if (!img) return;
		try {
			const blob = await sourceBlob(img.src);
			// the message's mime type can be a wildcard (images in Markdown): the real one is on the bytes
			const type = blob.type.startsWith("image/") ? blob.type : img.mimeType;
			const ext = type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9].*$/i, "") || "png";
			await saveFile(blob, `image-${(set?.index ?? 0) + 1}.${ext}`);
		} catch (e) {
			notify(`${t("저장하지 못했습니다")}: ${errorText(e)}`, false);
		}
	}

	/** The app toasts sit under the viewer (z-index), so the result is shown here, over the picture */
	let note = $state<{ text: string; ok: boolean; n: number; top: number } | null>(null);
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	let noteN = 0;
	const NOTE_H = 40;
	function notify(text: string, ok: boolean) {
		// just above the picture's top edge (follows zoom/pan); a picture that fills the height leaves no room, so the
		// note stops under the top bar and overlaps the picture's top a little
		const r = pic?.getBoundingClientRect();
		note = { text, ok, n: ++noteN, top: r ? r.top - NOTE_H - 10 : 0 };
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => (note = null), ok ? 2000 : 3000);
	}
	onDestroy(() => {
		clearTimeout(noteTimer);
		cancelHold();
	});

	async function copy() {
		if (!img) return;
		if (await copyImage(img.src)) notify(t("이미지를 복사했습니다"), true);
		else notify(t("복사하지 못했습니다"), false);
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
		if (e.key === "ArrowLeft") step(-1);
		else if (e.key === "ArrowRight") step(1);
		else if (e.key === "+" || e.key === "=") zoomTo(scale * 1.4);
		else if (e.key === "-") zoomTo(scale / 1.4);
		else if (e.key === "0") reset();
		else return;
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
	<div class="lb" bind:this={lb} role="dialog" aria-modal="true" aria-label={t("이미지 보기")} tabindex="-1" use:focus use:modalLayer={{ onclose, opener }} in:fadeIn|global out:fadeOut|global>
		<div
			class="stage"
			class:pan={scale > 1}
			class:dragging
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
				<img
					bind:this={pic}
					src={img.src}
					alt={t("첨부 이미지 {n}", { n: set.index + 1 })}
					draggable="false"
					style="transform: translate({x}px, {y}px) scale({scale})"
					class:snap={!dragging}
				/>
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
			<span class="grow"></span>
			<button class="ctl" onclick={() => zoomTo(scale / 1.4)} disabled={scale <= MIN} aria-label={t("축소")} title={t("축소") + " (-)"}>−</button>
			<button class="ctl pct mono" onclick={reset} aria-label={t("원래 크기로")} title={t("맞춤") + " (0)"}>{Math.round(scale * 100)}%</button>
			<button class="ctl" onclick={() => zoomTo(scale * 1.4)} disabled={scale >= MAX} aria-label={t("확대")} title={t("확대") + " (+)"}>+</button>
			<button class="ctl" onclick={copy} aria-label={t("이미지 복사")} title={t("이미지 복사") + " (Ctrl+C)"}>
				<Icon name="copy" />
			</button>
			<button class="ctl" onclick={save} aria-label={t("저장")} title={t("저장")}>
				<Icon name="download" />
			</button>
			<button class="ctl" onclick={onclose} aria-label={t("닫기")} title={t("닫기") + " (Esc)"}><Icon name="x" /></button>
		</div>

		{#if many && set.images.length <= 12}
			<div class="dots" aria-hidden="true">
				{#each set.images as _, i}<span class:on={i === set.index}></span>{/each}
			</div>
		{/if}

		{#if many}
			<button class="nav prev" onclick={() => step(-1)} aria-label={t("이전 이미지")} title={t("이전") + " (←)"}><Icon name="chevron-down" /></button>
			<button class="nav next" onclick={() => step(1)} aria-label={t("다음 이미지")} title={t("다음") + " (→)"}><Icon name="chevron-down" /></button>
		{/if}
	</div>
{/if}

<style>
	.lb {
		position: fixed;
		inset: 0;
		z-index: var(--z-lightbox);
		background: color-mix(in srgb, #000 82%, transparent);
		-webkit-backdrop-filter: blur(10px);
		backdrop-filter: blur(10px);
		outline: none;
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
		border-radius: 6px;
		box-shadow: 0 20px 80px rgba(0, 0, 0, 0.55);
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
		gap: 6px;
		padding: 12px 14px;
		pointer-events: none;
	}
	.bar > * {
		pointer-events: auto;
	}
	.top {
		top: 0;
		background: linear-gradient(to bottom, rgba(0, 0, 0, 0.5), transparent);
	}
	.grow {
		flex: 1;
		pointer-events: none;
	}
	.count {
		font-size: var(--fs-xs);
		color: rgba(255, 255, 255, 0.8);
	}
	.ctl {
		display: grid;
		place-items: center;
		min-width: 34px;
		height: 34px;
		padding: 0 8px;
		font-size: var(--fs-xl);
		line-height: 1;
		color: #fff;
		background: rgba(255, 255, 255, 0.12);
		border-radius: var(--radius);
		transition: background var(--motion-fast) var(--ease-std);
	}
	.ctl:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.22);
	}
	.ctl:disabled {
		opacity: 0.35;
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
		padding: 10px 18px;
		font-size: var(--fs-md, 14px);
		color: #fff;
		background: rgba(20, 20, 20, 0.88);
		border-radius: 18px;
		line-height: 1.35;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
		pointer-events: none;
		animation: note-in var(--motion-fast) var(--ease-std);
	}
	.note.err {
		background: rgba(150, 30, 30, 0.92);
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
		bottom: calc(14px + env(safe-area-inset-bottom, 0px));
		display: flex;
		justify-content: center;
		gap: 6px;
		pointer-events: none;
	}
	.dots span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.35);
		transition: background var(--motion-fast) var(--ease-std), scale var(--motion-fast) var(--ease-std);
	}
	.dots span.on {
		background: #fff;
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
		color: #fff;
		background: rgba(255, 255, 255, 0.12);
		border-radius: 50%;
		transition: background var(--motion-fast) var(--ease-std);
	}
	.nav:hover {
		background: rgba(255, 255, 255, 0.24);
	}
	.nav :global(svg) {
		width: 22px;
		height: 22px;
		stroke-width: 2;
	}
	.prev {
		left: 14px;
	}
	.prev :global(svg) {
		rotate: 90deg;
	}
	.next {
		right: 14px;
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
</style>
