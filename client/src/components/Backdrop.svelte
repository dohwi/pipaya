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
	};
	export const DUR = 1200; // ms: how long a wave travels
	/** ms of holding the pointer down on empty space for a full gauge. */
	export const CHARGE = 900;
	/** Lit band width, from a quick tap to a full charge. */
	const BAND = { min: 150, max: 340 };
	/** Peak opacity of the wave, from a quick tap to a full charge. */
	const PEAK = { min: 0.72, max: 1 };
	const EASE = 1.7; // radius = reach * (1 - (1 - p) ** EASE)
	/** ms after the click at which the wave front reaches a point `dist` px from the click. */
	export function arrival(reach: number, dist: number): number {
		return (1 - (1 - Math.min(1, dist / reach)) ** (1 / EASE)) * DUR;
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
			const p = Math.min(1, (now - b.t0) / DUR);
			b.r = b.reach * (1 - (1 - p) ** EASE);
			// ease in over the first 12%, hold, then fade out smoothly
			const fin = Math.min(1, p / 0.12);
			const fout = p < 0.45 ? 1 : 1 - (p - 0.45) / 0.55;
			b.a = fin * fin * (3 - 2 * fin) * fout * fout * (3 - 2 * fout) * b.pk;
		}
		bursts = bursts.filter((b) => now - b.t0 < DUR);
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
		bursts.push({ id: seq++, x: c.x, y: c.y, reach, t0: performance.now(), r: 0, a: pk, pk, band });
		if (!ripRaf) ripRaf = requestAnimationFrame(tick);
	};

	/** Holding the pointer down on empty space charges the gauge; the wave only leaves when it is released. */
	$effect(() => {
		const el = host;
		const parent = el?.parentElement;
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

		const parent = el.parentElement;
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
		></div>
	{/if}
	{#each bursts as b (b.id)}
		<div
			class="wave"
			style="--cx:{b.x}px;--cy:{b.y}px;--r:{b.r.toFixed(1)}px;--band:{b.band}px;opacity:{b.a.toFixed(3)}"
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
	/* the resting grid fades out downward, like the hero band it replaces */
	.grid {
		-webkit-mask-image: linear-gradient(to bottom, #000 0%, transparent min(30rem, 70%));
		mask-image: linear-gradient(to bottom, #000 0%, transparent min(30rem, 70%));
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
	/* the gauge that fills while the pointer is held down on empty space */
	.charge {
		position: absolute;
		width: 48px;
		height: 48px;
		translate: -50% -50%;
		border-radius: 50%;
	}
	/* the ring: an arc that sweeps clockwise from the top as the hold goes on */
	.charge::before {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: conic-gradient(from -90deg, var(--grid-wave) calc(var(--p) * 360deg), transparent 0);
		-webkit-mask-image: radial-gradient(closest-side, transparent 78%, #000 80%);
		mask-image: radial-gradient(closest-side, transparent 78%, #000 80%);
	}
	/* the core brightens and widens with the charge, so the gauge reads even before the ring closes */
	.charge::after {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: radial-gradient(closest-side, var(--grid-wave), transparent 70%);
		opacity: calc(0.18 + var(--p) * 0.5);
		scale: calc(0.45 + var(--p) * 0.55);
	}
	/* at full charge the ring breathes, so the ceiling is visible without a number */
	.charge.full::before {
		animation: charged 900ms var(--ease-std) infinite;
	}
	@keyframes charged {
		50% {
			opacity: 0.45;
		}
	}
	.lit::after {
		content: "";
		position: absolute;
		inset: 0;
		background: radial-gradient(420px circle at var(--mx) var(--my), var(--glow) 0%, transparent 70%);
	}
</style>
