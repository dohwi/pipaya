<script lang="ts" module>
	/** `dur`: how long this wave travels (a charged one, see `chargedDur`, is faster). */
	export type Burst = { id: number; x: number; y: number; reach: number; t0: number; dur: number; r: number; a: number };
	export const DUR = 1200; // ms: how long a wave travels (faster than the first 1900ms spread)
	export const HOLD = 150; // ms: a press held this long starts charging (shorter is just a click)
	export const CHARGE = 800; // ms: from the start of charging until the gauge is full
	const FASTEST = 0.45; // a full charge travels in this share of DUR
	const EASE = 1.7; // radius = reach * (1 - (1 - p) ** EASE)
	/** ms after the wave starts at which its front reaches a point `dist` px from where it started. */
	export function arrival(reach: number, dist: number, dur = DUR): number {
		return (1 - (1 - Math.min(1, dist / reach)) ** (1 / EASE)) * dur;
	}
	/** Charge level 0..1 after holding `held` ms. */
	export const chargeLevel = (held: number) => Math.max(0, Math.min(1, (held - HOLD) / CHARGE));
	/** Travel time of the wave released at charge `level` (0..1): the fuller the gauge, the faster it spreads. */
	export const chargedDur = (level: number) => Math.round(DUR * (1 - (1 - FASTEST) * level));
</script>

<script lang="ts">
	import { schedule, unschedule } from "../../lib/frame";
	import { buzz } from "../../lib/press-menu";
	/**
	 * The empty-state background: the blueprint grid, plus a soft light that follows the pointer and
	 * brings the grid up around it. Pure decoration — pointer-events none, off for touch and reduced motion.
	 */
	/** The live waves, bindable so the owner can follow them (the empty-state mark turns colour as a wave passes). */
	let { bursts = $bindable([]) }: { bursts?: Burst[] } = $props();
	let host: HTMLDivElement | undefined = $state();
	/** Same box as `host`, but above the page: the gauge must not slip under the mark or the start actions. */
	let over: HTMLDivElement | undefined = $state();
	let seq = 0;
	const RING = 220; // px: width of the lit band
	const SLOP = 10; // px: moving further than this before the gauge shows is a swipe or a scroll, not a press
	/** The press being held on empty space: the gauge at (x, y) shows while `shown`. */
	let charge: { x: number; y: number; shown: boolean; full: boolean } | null = $state(null);

	let ripRaf = 0;
	// Drives every wave's radius by hand (like the hover light), so it does not depend on animating custom properties.
	const tick = (now: number) => {
		for (const b of bursts) {
			const p = Math.min(1, (now - b.t0) / b.dur);
			b.r = b.reach * (1 - (1 - p) ** EASE);
			// ease in over the first 12%, hold, then fade out smoothly
			const fin = Math.min(1, p / 0.12);
			const fout = p < 0.45 ? 1 : 1 - (p - 0.45) / 0.55;
			b.a = fin * fin * (3 - 2 * fin) * fout * fout * (3 - 2 * fout);
		}
		bursts = bursts.filter((b) => now - b.t0 < b.dur);
		ripRaf = bursts.length ? requestAnimationFrame(tick) : 0;
	};
	$effect(() => () => cancelAnimationFrame(ripRaf));

	/** Inside a pane the backdrop reaches the pane's bottom edge (under the input and the stats line), not just the message area. */
	$effect(() => {
		const el = host;
		const top = over;
		const pane = el?.closest<HTMLElement>(".pane");
		const body = el?.parentElement;
		if (!el || !top || !pane || !body) return;
		el.style.zIndex = "-1"; // behind the input and the stats line, which the grid now runs under
		// fixed, so the scrolling .empty cannot clip it; placed from the pane's rect (body top .. pane bottom)
		el.style.position = "fixed";
		top.style.position = "fixed";
		// reads and writes of all panes are batched per frame (see lib/frame.ts)
		const key = {};
		const fit = () => {
			const p = pane.getBoundingClientRect();
			const t = body.getBoundingClientRect().top;
			return () => {
				for (const n of [el, top]) {
					n.style.inset = `${t}px auto auto ${p.left}px`;
					n.style.width = `${p.width}px`;
					n.style.height = `${Math.max(0, p.bottom - t)}px`;
				}
			};
		};
		fit()();
		const queue = () => schedule(key, fit);
		const ro = new ResizeObserver(queue);
		ro.observe(pane);
		ro.observe(body);
		addEventListener("resize", queue);
		return () => {
			ro.disconnect();
			unschedule(key);
			removeEventListener("resize", queue);
		};
	});

	/**
	 * A click on empty space sends a wave of lit grid lines out from where it is let go. Holding the press instead fills a
	 * round gauge that follows the pointer; letting go sends the wave from there, faster the fuller the gauge is.
	 */
	$effect(() => {
		const el = host;
		const parent = el?.closest<HTMLElement>(".pane") ?? el?.parentElement;
		if (!el || !parent || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const wave = (x: number, y: number, dur: number) => {
			const r = el.getBoundingClientRect();
			const far = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
			bursts.push({ id: seq++, x, y, reach: far + RING, t0: performance.now(), dur, r: 0, a: 1 });
			if (!ripRaf) ripRaf = requestAnimationFrame(tick);
		};

		let held: { id: number; cx: number; cy: number; x: number; y: number; t0: number } | null = null;
		let showTimer: ReturnType<typeof setTimeout> | undefined;
		let fullTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			clearTimeout(showTimer);
			clearTimeout(fullTimer);
			removeEventListener("pointermove", move);
			removeEventListener("touchmove", hold);
			removeEventListener("selectstart", noSelect);
			removeEventListener("pointerup", up);
			removeEventListener("pointercancel", stop);
			removeEventListener("blur", stop);
			held = null;
			charge = null;
		};
		const move = (e: PointerEvent) => {
			if (!held || e.pointerId !== held.id) return;
			if (!charge) {
				if (Math.hypot(e.clientX - held.cx, e.clientY - held.cy) > SLOP) stop();
				return;
			}
			const r = el.getBoundingClientRect();
			held.x = charge.x = e.clientX - r.left;
			held.y = charge.y = e.clientY - r.top;
			getSelection()?.removeAllRanges(); // a selection begun with the press would follow the drag
		};
		// once the gauge shows, a moving finger drags it instead of scrolling the page
		const hold = (e: TouchEvent) => {
			if (charge && e.cancelable) e.preventDefault();
		};
		// and a moving mouse does not select text on its way
		const noSelect = (e: Event) => charge && e.preventDefault();
		const up = (e: PointerEvent) => {
			if (!held || e.pointerId !== held.id) return;
			const level = chargeLevel(performance.now() - held.t0);
			const { x, y } = held;
			stop();
			wave(x, y, level > 0 ? chargedDur(level) : DUR);
		};
		const down = (e: PointerEvent) => {
			if (e.button !== 0 || held) return;
			if ((e.target as Element | null)?.closest("button, a, input, textarea, select, summary, [contenteditable], [role=button]")) return;
			const r = el.getBoundingClientRect();
			const x = e.clientX - r.left;
			const y = e.clientY - r.top;
			held = { id: e.pointerId, cx: e.clientX, cy: e.clientY, x, y, t0: performance.now() };
			showTimer = setTimeout(() => (charge = { x, y, shown: true, full: false }), HOLD);
			fullTimer = setTimeout(() => {
				if (charge) charge.full = true;
				buzz();
			}, HOLD + CHARGE);
			addEventListener("pointermove", move, { passive: true });
			addEventListener("touchmove", hold, { passive: false });
			addEventListener("selectstart", noSelect);
			addEventListener("pointerup", up);
			addEventListener("pointercancel", stop);
			addEventListener("blur", stop);
		};
		parent.addEventListener("pointerdown", down, { passive: true });
		return () => {
			parent.removeEventListener("pointerdown", down);
			stop();
		};
	});

	$effect(() => {
		const el = host;
		if (!el) return;
		if (!matchMedia("(hover: hover) and (pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

		const parent = el.closest<HTMLElement>(".pane") ?? el.parentElement;
		if (!parent) return;
		let tx = 0;
		let ty = 0;
		let x = 0;
		let y = 0;
		let on = false;
		let raf = 0;

		// Ease toward the pointer so the light trails it instead of snapping
		const step = () => {
			x += (tx - x) * 0.14;
			y += (ty - y) * 0.14;
			el.style.setProperty("--mx", `${x.toFixed(1)}px`);
			el.style.setProperty("--my", `${y.toFixed(1)}px`);
			raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.4 ? requestAnimationFrame(step) : 0;
		};
		const kick = () => {
			if (!raf) raf = requestAnimationFrame(step);
		};
		const move = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			tx = e.clientX - r.left;
			ty = e.clientY - r.top;
			if (!on) {
				on = true;
				x = tx;
				y = ty;
				el.style.setProperty("--lit", "1");
			}
			kick();
		};
		const leave = () => {
			on = false;
			el.style.setProperty("--lit", "0");
		};

		parent.addEventListener("pointermove", move, { passive: true });
		parent.addEventListener("pointerleave", leave);
		return () => {
			parent.removeEventListener("pointermove", move);
			parent.removeEventListener("pointerleave", leave);
			cancelAnimationFrame(raf);
		};
	});
</script>

<div class="backdrop" bind:this={host} aria-hidden="true">
	<div class="grid"></div>
	<div class="lit"></div>
	{#each bursts as b (b.id)}
		<div
			class="wave"
			style="--cx:{b.x}px;--cy:{b.y}px;--r:{b.r.toFixed(1)}px;opacity:{b.a.toFixed(3)}"
		></div>
	{/each}
</div>
<div class="backdrop over" bind:this={over} aria-hidden="true">
	{#if charge?.shown}
		<!-- the charge gauge: a ring that fills clockwise while the press is held (CSS animation, CHARGE ms) -->
		<svg class="gauge" class:full={charge.full} style="--cx:{charge.x}px;--cy:{charge.y}px;--charge:{CHARGE}ms" viewBox="0 0 48 48">
			<circle class="track" cx="24" cy="24" r="20" />
			<circle class="fill" cx="24" cy="24" r="20" pathLength="100" />
		</svg>
	{/if}
</div>

<style>
	.backdrop {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		--mx: 50%;
		--my: 38%;
		--lit: 0;
	}
	/* the gauge layer: over the mark, the start actions and the input (inside the pane's isolated stack) */
	.over {
		z-index: 1;
	}
	.grid,
	.lit {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, transparent calc(100% - 1px), var(--line, var(--grid-line)) 100%),
			linear-gradient(to bottom, transparent calc(100% - 1px), var(--line, var(--grid-line)) 100%);
		background-size: 2rem 2rem;
		background-position: center top;
	}
	/* the same grid, brighter, shown only through a soft circle around the pointer */
	.lit {
		--line: var(--grid-lit);
		opacity: var(--lit);
		transition: opacity var(--motion-slow) var(--ease-std);
		-webkit-mask-image: radial-gradient(260px circle at var(--mx) var(--my), #000 0%, transparent 100%);
		mask-image: radial-gradient(260px circle at var(--mx) var(--my), #000 0%, transparent 100%);
	}
	/* the hover grid again, but shown through a ring that travels out from the click */
	.wave {
		position: absolute;
		inset: 0;
		--line: var(--grid-wave);
		background-image:
			linear-gradient(to right, transparent calc(100% - 1px), var(--line) 100%),
			linear-gradient(to bottom, transparent calc(100% - 1px), var(--line) 100%);
		background-size: 2rem 2rem;
		background-position: center top;
		--mask: radial-gradient(circle at var(--cx) var(--cy), transparent calc(var(--r) - 220px), #000 calc(var(--r) - 40px), transparent var(--r));
		-webkit-mask-image: var(--mask);
		mask-image: var(--mask);
	}
	/* 48px box centred on the press (left/top minus half the box), so the ring sits around the finger */
	.gauge {
		position: absolute;
		left: calc(var(--cx) - 24px);
		top: calc(var(--cy) - 24px);
		width: 48px;
		height: 48px;
		transform: rotate(-90deg); /* start filling at 12 o'clock */
		animation: gauge-in var(--motion-fast) var(--ease) both;
	}
	.gauge circle {
		fill: none;
		stroke-width: 3;
	}
	.track {
		stroke: var(--grid-lit);
	}
	.fill {
		stroke: var(--grid-wave);
		stroke-linecap: round;
		stroke-dasharray: 100;
		animation: gauge-fill var(--charge) linear both;
	}
	.gauge.full .fill {
		stroke: var(--accent);
	}
	.gauge.full {
		animation: gauge-pop var(--motion-normal) var(--ease) both;
	}
	@keyframes gauge-in {
		from {
			opacity: 0;
			scale: 0.6;
		}
	}
	@keyframes gauge-fill {
		from {
			stroke-dashoffset: 100;
		}
		to {
			stroke-dashoffset: 0;
		}
	}
	@keyframes gauge-pop {
		50% {
			scale: 1.15;
		}
	}
	.lit::after {
		content: "";
		position: absolute;
		inset: 0;
		background: radial-gradient(420px circle at var(--mx) var(--my), var(--glow) 0%, transparent 70%);
	}
</style>
