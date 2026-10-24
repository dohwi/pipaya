<script lang="ts">
	// what had focus before this opened (captured before any child focuses itself): where focus returns on close
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	import { modalLayer, topLayer } from "../lib/dialog";
	let lb: HTMLElement | undefined = $state();
	import { t } from "../lib/i18n";
	import { fadeIn, fadeOut } from "../lib/motion";
	import Icon from "./Icon.svelte";
	import { app } from "../lib/store.svelte";

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

	function ondown(e: PointerEvent) {
		downOnBackdrop = !overPicture(e);
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		moved = false;
		if (pts.size === 2) pinch = dist();
		else from = { x: e.clientX, y: e.clientY, px: x, py: y };
		dragging = scale > 1;
	}

	const dist = () => {
		const [a, b] = [...pts.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	function onmove(e: PointerEvent) {
		if (!pts.has(e.pointerId)) return;
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
		}
	}

	function onup(e: PointerEvent) {
		pts.delete(e.pointerId);
		pinch = 0;
		dragging = false;
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

	function save() {
		if (!img) return;
		const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
		const a = document.createElement("a");
		a.href = img.src;
		a.download = `image-${(set?.index ?? 0) + 1}.${ext}`;
		a.click();
	}

	function onkey(e: KeyboardEvent) {
		// over the viewer only: a dialog opened on top of it (none today) would keep its own arrows
		if (topLayer() !== lb) return;
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

		<div class="bar top">
			{#if many}<span class="count mono">{set.index + 1} / {set.images.length}</span>{/if}
			<span class="grow"></span>
			<button class="ctl" onclick={() => zoomTo(scale / 1.4)} disabled={scale <= MIN} aria-label={t("축소")} title={t("축소") + " (-)"}>−</button>
			<button class="ctl pct mono" onclick={reset} aria-label={t("원래 크기로")} title={t("맞춤") + " (0)"}>{Math.round(scale * 100)}%</button>
			<button class="ctl" onclick={() => zoomTo(scale * 1.4)} disabled={scale >= MAX} aria-label={t("확대")} title={t("확대") + " (+)"}>+</button>
			<button class="ctl" onclick={save} aria-label={t("저장")} title={t("저장")}>
				<Icon name="download" />
			</button>
			<button class="ctl" onclick={onclose} aria-label={t("닫기")} title={t("닫기") + " (Esc)"}><Icon name="x" /></button>
		</div>

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
		max-height: 88vh;
		object-fit: contain;
		border-radius: 6px;
		box-shadow: 0 20px 80px rgba(0, 0, 0, 0.55);
		user-select: none;
		-webkit-user-drag: none;
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
	@media (prefers-reduced-motion: reduce) {
		img.snap {
			transition: none;
		}
	}
</style>
