<script lang="ts">
	/**
	 * The empty-state background: the blueprint grid, plus a soft light that follows the pointer and
	 * brings the grid up around it. Pure decoration — pointer-events none, off for touch and reduced motion.
	 */
	let { onburst }: { onburst?: (x: number, y: number) => void } = $props();
	let host: HTMLDivElement | undefined = $state();
	type Burst = { id: number; x: number; y: number; r: number; hue: number };
	let bursts: Burst[] = $state([]);
	let seq = 0;

	// A click on empty space sends a colour wave out from the pointer (and tells the owner, so the mark can tint).
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
			bursts.push({ id: seq++, x, y, r: far, hue: Math.round(Math.random() * 360) });
			onburst?.(x / r.width, y / r.height);
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
			class="burst"
			style="left:{b.x}px;top:{b.y}px;width:{b.r * 2}px;height:{b.r * 2}px;--h:{b.hue}"
			onanimationend={() => (bursts = bursts.filter((o) => o.id !== b.id))}
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
	.burst {
		position: absolute;
		border-radius: 50%;
		transform: translate(-50%, -50%) scale(0);
		opacity: 0;
		background: radial-gradient(
			circle closest-side,
			hsl(var(--h) 90% 60% / 0.1) 0%,
			hsl(var(--h) 90% 60% / 0.16) 45%,
			hsl(calc(var(--h) + 50) 90% 62% / 0.34) 66%,
			hsl(calc(var(--h) + 110) 90% 62% / 0.2) 82%,
			transparent 100%
		);
		animation: burst 1.1s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
	}
	@keyframes burst {
		0% {
			transform: translate(-50%, -50%) scale(0);
			opacity: 1;
		}
		70% {
			opacity: 0.8;
		}
		100% {
			transform: translate(-50%, -50%) scale(1);
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
