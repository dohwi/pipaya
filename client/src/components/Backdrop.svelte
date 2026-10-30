<script lang="ts" module>
	export type Burst = {
		id: number;
		x: number;
		y: number;
		reach: number;
		t0: number;
		r: number;
		a: number;
		pk: number; // peak opacity: how bright this wave gets (a tap is faint, a full charge is not)
		band: number; // px: width of the lit band that travels with the front
		dur: number; // ms this wave takes to travel: a charged wave bursts out much faster
	};
	/** ms of holding the pointer down on empty space for a full gauge. */
	export const CHARGE = 900;
	/** Lit band width, from a quick tap to a full charge. */
	const BAND = { min: 150, max: 340 };
	/** Peak opacity of the wave, from a quick tap to a full charge. */
	const PEAK = { min: 0.72, max: 1 };
	/** Travel time, from a quick tap (the slowest wave) to a full charge (the fastest). */
	const DUR = { tap: 1100, full: 600 };
	const EASE = 1.7; // radius = reach * (1 - (1 - p) ** EASE)
	/** ms after the release at which the wave front reaches a point `dist` px from it. */
	export function arrival(b: Burst, dist: number): number {
		return (1 - (1 - Math.min(1, dist / b.reach)) ** (1 / EASE)) * b.dur;
	}
</script>

<script lang="ts">
	/**
	 * The empty-state background: the blueprint grid, plus a soft light that follows the pointer and
	 * brings the grid up around it. Pure decoration — pointer-events none, off for touch and reduced motion.
	 */
	/** The live waves, bindable so the owner can follow them (the empty-state mark turns colour as a wave passes). */
	let { bursts = $bindable([]) }: { bursts?: Burst[] } = $props();
	let host: HTMLDivElement | undefined = $state();
	let seq = 0;

	/** The pointer held down on empty space: where it went down and how full the gauge is (0..1). */
	let press: { x: number; y: number; p: number } | null = $state(null);
	let chargeRaf = 0;
	let chargeT0 = 0;

	let ripRaf = 0;
	// Drives every wave's radius by hand (like the hover light), so it does not depend on animating custom properties.
	const tick = (now: number) => {
		for (const b of bursts) {
			const p = Math.min(1, (now - b.t0) / b.dur);
			b.r = b.reach * (1 - (1 - p) ** EASE);
			// ease in over the first 12%, hold, then fade out smoothly
			const fin = Math.min(1, p / 0.12);
			const fout = p < 0.45 ? 1 : 1 - (p - 0.45) / 0.55;
			b.a = fin * fin * (3 - 2 * fin) * fout * fout * (3 - 2 * fout) * b.pk;
		}
		bursts = bursts.filter((b) => now - b.t0 < b.dur);
		ripRaf = bursts.length ? requestAnimationFrame(tick) : 0;
	};
	$effect(() => () => {
		cancelAnimationFrame(ripRaf);
		cancelAnimationFrame(chargeRaf);
	});

	/** The pointer went up: send a wave whose size, brightness and speed follow how long it was held. */
	const release = () => {
		const el = host;
		const c = press;
		cancelAnimationFrame(chargeRaf);
		chargeRaf = 0;
		press = null;
		if (!el || !c) return;
		const r = el.getBoundingClientRect();
		const far = Math.hypot(Math.max(c.x, r.width - c.x), Math.max(c.y, r.height - c.y));
		const band = BAND.min + (BAND.max - BAND.min) * c.p;
		// a tap stops short of the farthest corner, a full charge crosses the whole screen
		const reach = far * (0.7 + 0.3 * c.p) + band;
		const pk = PEAK.min + (PEAK.max - PEAK.min) * c.p;
		// the fuller the gauge, the harder it bursts: a full charge crosses the screen twice as fast as a tap
		const dur = DUR.tap + (DUR.full - DUR.tap) * c.p;
		bursts.push({ id: seq++, x: c.x, y: c.y, reach, dur, t0: performance.now(), r: 0, a: pk, pk, band });
		if (!ripRaf) ripRaf = requestAnimationFrame(tick);
	};

	/** Holding the pointer down on empty space charges the gauge; the wave only leaves when it is released. */
	/** Inside a pane the backdrop reaches the pane's bottom edge (under the input and the stats line), not just the message area. */
	$effect(() => {
		const el = host;
		const pane = el?.closest<HTMLElement>(".pane");
		const body = el?.parentElement;
		if (!el || !pane || !body) return;
		el.style.zIndex = "-1"; // behind the input and the stats line, which the grid now runs under
		// fixed, so the scrolling .empty cannot clip it; placed from the pane's rect (body top .. pane bottom)
		el.style.position = "fixed";
		const fit = () => {
			const p = pane.getBoundingClientRect();
			const t = body.getBoundingClientRect().top;
			el.style.inset = `${t}px auto auto ${p.left}px`;
			el.style.width = `${p.width}px`;
			el.style.height = `${Math.max(0, p.bottom - t)}px`;
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(pane);
		ro.observe(body);
		addEventListener("resize", fit);
		return () => {
			ro.disconnect();
			removeEventListener("resize", fit);
		};
	});

	$effect(() => {
		const el = host;
		const parent = el?.closest<HTMLElement>(".pane") ?? el?.parentElement;
		if (!el || !parent || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

		const step = (now: number) => {
			if (!press) {
				chargeRaf = 0;
				return;
			}
			press.p = Math.min(1, (now - chargeT0) / CHARGE);
			chargeRaf = press.p < 1 ? requestAnimationFrame(step) : 0;
		};
		const down = (e: PointerEvent) => {
			if (e.button !== 0 || press) return;
			if ((e.target as Element | null)?.closest("button, a, input, textarea, select, summary, [contenteditable], [role=button]")) return;
			const r = el.getBoundingClientRect();
			chargeT0 = performance.now();
			press = { x: e.clientX - r.left, y: e.clientY - r.top, p: 0 };
			if (!chargeRaf) chargeRaf = requestAnimationFrame(step);
		};
		const up = (e: PointerEvent) => {
			if (e.button === 0) release();
		};
		const abort = () => {
			cancelAnimationFrame(chargeRaf);
			chargeRaf = 0;
			press = null;
		};
		parent.addEventListener("pointerdown", down, { passive: true });
		// the release can happen anywhere (dragged off the empty space first), so listen on the window
		window.addEventListener("pointerup", up, { passive: true });
		window.addEventListener("pointercancel", abort);
		parent.addEventListener("pointerleave", abort);
		return () => {
			parent.removeEventListener("pointerdown", down);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", abort);
			parent.removeEventListener("pointerleave", abort);
			abort();
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
	{#if press}
		<div
			class="charge"
			class:full={press.p >= 1}
			style="left:{press.x}px;top:{press.y}px;--p:{press.p.toFixed(3)}"
		>
			<div class="spin a"></div>
			<div class="spin b"></div>
		</div>
	{/if}
	{#each bursts as b (b.id)}
		<div
			class="wave"
			style="--cx:{b.x}px;--cy:{b.y}px;--r:{b.r.toFixed(1)}px;--band:{b.band}px;opacity:{b.a.toFixed(3)}"
		></div>
		<!-- the halo that leaves with the wave, as wide and as quick as the charge made it -->
		<div
			class="flash"
			style="--cx:{b.x}px;--cy:{b.y}px;--k:{b.pk.toFixed(2)};--fd:{Math.round(b.dur * 0.65)}ms"
		></div>
	{/each}
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
		--mask: radial-gradient(circle at var(--cx) var(--cy), transparent calc(var(--r) - var(--band)), #000 calc(var(--r) - var(--band) * 0.18), transparent var(--r));
		-webkit-mask-image: var(--mask);
		mask-image: var(--mask);
	}
	/* the light gathering under the pointer while it is held down on empty space */
	.charge {
		position: absolute;
		width: 240px;
		height: 240px;
		translate: -50% -50%;
		--p: 0;
	}
	/* two counter-turning veils of hairlines, drifting inward: the lit ring settles onto the point as the gauge fills */
	.spin {
		position: absolute;
		inset: 0;
		--inner: calc(66% - 62% * var(--p));
		--outer: calc(88% - 74% * var(--p));
		-webkit-mask-image: radial-gradient(closest-side, transparent var(--inner), #000 calc(var(--inner) + 9%), #000 var(--outer), transparent calc(var(--outer) + 10%));
		mask-image: radial-gradient(closest-side, transparent var(--inner), #000 calc(var(--inner) + 9%), #000 var(--outer), transparent calc(var(--outer) + 10%));
		filter: blur(0.6px);
	}
	.spin.a {
		background: repeating-conic-gradient(from 0deg, var(--grid-wave) 0deg 0.7deg, transparent 0.7deg 14deg);
		opacity: calc(0.1 + var(--p) * 0.22);
		animation: gather 9s linear infinite;
	}
	.spin.b {
		background: repeating-conic-gradient(from 5deg, var(--grid-wave) 0deg 1deg, transparent 1deg 22deg);
		opacity: calc(0.08 + var(--p) * 0.18);
		animation: gather 14s linear infinite reverse;
	}
	@keyframes gather {
		to {
			rotate: 1turn;
		}
	}
	/* the core: a soft bloom that warms and settles a little tighter as the gauge fills */
	.charge::after {
		content: "";
		position: absolute;
		inset: 32%;
		border-radius: 50%;
		background: radial-gradient(closest-side, var(--grid-wave) 0%, transparent 78%);
		opacity: calc(0.08 + var(--p) * 0.42);
		scale: calc(1.5 - var(--p) * 0.55);
		filter: blur(2px);
	}
	/* a full gauge breathes, so the ceiling is visible without a number */
	.charge.full::after {
		animation: charged 2600ms var(--ease-std) infinite;
	}
	@keyframes charged {
		50% {
			opacity: 0.34;
		}
	}
	/* the burst that leaves with the wave: a soft halo that widens and thins out */
	.flash {
		position: absolute;
		left: var(--cx);
		top: var(--cy);
		width: 380px;
		height: 380px;
		translate: -50% -50%;
		border-radius: 50%;
		background: radial-gradient(closest-side, var(--grid-wave) 0%, transparent 78%);
		filter: blur(3px);
		animation: burst var(--fd) var(--ease-std) both;
	}
	@keyframes burst {
		0% {
			scale: 0.35;
			opacity: 0;
		}
		30% {
			opacity: calc(var(--k) * 0.45);
		}
		100% {
			scale: 1.9;
			opacity: 0;
		}
	}
	.lit::after {
		content: "";
		position: absolute;
		inset: 0;
		background: radial-gradient(420px circle at var(--mx) var(--my), var(--glow) 0%, transparent 70%);
	}
</style>
