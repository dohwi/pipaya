<script lang="ts">
	/**
	 * The empty-state background: the blueprint grid, plus a soft light that follows the pointer and
	 * brings the grid up around it. Pure decoration — pointer-events none, off for touch and reduced motion.
	 */
	let host: HTMLDivElement | undefined = $state();
	type Burst = { id: number; x: number; y: number; reach: number; t0: number; r: number; a: number };
	let bursts: Burst[] = $state([]);
	let seq = 0;
	const RING = 220; // px: width of the lit band
	const DUR = 1300; // ms

	let ripRaf = 0;
	// Drives every wave's radius by hand (like the hover light), so it does not depend on animating custom properties.
	const tick = (now: number) => {
		for (const b of bursts) {
			const p = Math.min(1, (now - b.t0) / DUR);
			b.r = b.reach * (1 - (1 - p) ** 2.2);
			b.a = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
		}
		bursts = bursts.filter((b) => now - b.t0 < DUR);
		ripRaf = bursts.length ? requestAnimationFrame(tick) : 0;
	};
	$effect(() => () => cancelAnimationFrame(ripRaf));

	// A click on empty space sends a wave of lit grid lines out from the pointer.
	$effect(() => {
		const el = host;
		const parent = el?.parentElement;
		if (!el || !parent || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const down = (e: PointerEvent) => {
			if (e.button !== 0) return;
			if ((e.target as Element | null)?.closest("button, a, input, textarea, select, summary, [contenteditable], [role=button]")) return;
			const r = el.getBoundingClientRect();
			const x = e.clientX - r.left;
			const y = e.clientY - r.top;
			const far = Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
			bursts.push({ id: seq++, x, y, reach: far + RING, t0: performance.now(), r: 0, a: 1 });
			if (!ripRaf) ripRaf = requestAnimationFrame(tick);
		};
		parent.addEventListener("pointerdown", down, { passive: true });
		return () => parent.removeEventListener("pointerdown", down);
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
	{#each bursts as b (b.id)}
		<div
			class="wave"
			style="--cx:{b.x}px;--cy:{b.y}px;--r:{b.r.toFixed(1)}px;opacity:{b.a.toFixed(3)}"
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
		--mask: radial-gradient(circle at var(--cx) var(--cy), transparent calc(var(--r) - 220px), #000 calc(var(--r) - 40px), transparent var(--r));
		-webkit-mask-image: var(--mask);
		mask-image: var(--mask);
	}
	.lit::after {
		content: "";
		position: absolute;
		inset: 0;
		background: radial-gradient(420px circle at var(--mx) var(--my), var(--glow) 0%, transparent 70%);
	}
</style>
