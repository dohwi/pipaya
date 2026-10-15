<script lang="ts" module>
	/**
	 * pipaya mark: a papaya tree whose trunk is the face (5 fronds, 2 fruit). Geometry on a 128 grid, same as logo/build.py.
	 *
	 *  - static (default): the finished shape.
	 *  - `eyes`: the agent. `face` picks one of the eight expressions (default block). `blink` plays the 3s double blink (0.8s and 1.9s).
	 *  - `color`: the two-tone artwork. Default is the single-colour mark (currentColor, fruit and eyes knocked out).
	 *  Reduced motion never animates.
	 */
	let uid = 0;
</script>

<script lang="ts">
	import { FACES, type FaceName } from "../lib/faces";

	let {
		color = false,
		size = 22,
		eyes = false,
		face = "block",
		blink = false,
	}: { color?: boolean; size?: number; eyes?: boolean; face?: FaceName; blink?: boolean } = $props();

	const TRUNK = "M52 60H76L84 118H44Z";
	const LEAF = "M0 0C-11 -12 -11 -30 0 -46C11 -30 11 -12 0 0Z";
	const FRONDS = [
		[-80, 0.8],
		[-42, 0.95],
		[0, 1],
		[42, 0.95],
		[80, 0.8],
	] as const;
	const FRUITS = [58, 70] as const;
	const FACE_C = [64, 89] as const;
	const FS = 0.78;

	const mid = `pk${uid++}`;
	const eyePaths = $derived(FACES[face].eyes);
	/** Centre of the eye region, so every expression sits on the middle of the trunk. */
	const place = $derived.by(() => {
		const v = eyePaths.flatMap((d) => d.match(/-?\d+(?:\.\d+)?/g)!.map(Number));
		const xs = v.filter((_, i) => i % 2 === 0);
		const ys = v.filter((_, i) => i % 2 === 1);
		const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
		const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
		return `translate(${(FACE_C[0] - cx * FS).toFixed(2)} ${(FACE_C[1] - cy * FS).toFixed(2)}) scale(${FS})`;
	});
</script>

<svg class="logo" class:color class:blink={eyes && blink} width={size} height={size} viewBox="0 0 128 128" role="img" aria-label="pipaya">
	{#if color}
		<path class="trunk" d={TRUNK} />
		<ellipse class="leaf" cx="64" cy="53.5" rx="5.5" ry="7.5" />
		{#each FRONDS as [angle, k]}
			<path class="leaf" d={LEAF} transform="translate(64 59) rotate({angle}) scale(.92 {k})" />
		{/each}
		{#each FRUITS as x}<circle class="fruit" cx={x} cy="64" r="5.2" />{/each}
		{#if eyes}
			<g class="eyes" transform={place}>
				{#each eyePaths as d}<path {d} />{/each}
			</g>
		{/if}
	{:else}
		<defs>
			<mask id={mid} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
				<rect width="128" height="128" fill="#fff" />
				{#each FRUITS as x}<circle cx={x} cy="64" r="8.2" fill="#000" />{/each}
				{#if eyes}
					<g class="eyes" transform={place} fill="#000">
						{#each eyePaths as d}<path {d} />{/each}
					</g>
				{/if}
			</mask>
		</defs>
		<g mask="url(#{mid})" fill="currentColor">
			<path d={TRUNK} />
			<ellipse cx="64" cy="53.5" rx="5.5" ry="7.5" />
			{#each FRONDS as [angle, k]}
				<path d={LEAF} transform="translate(64 59) rotate({angle}) scale(.92 {k})" />
			{/each}
		</g>
		{#each FRUITS as x}<circle cx={x} cy="64" r="5.2" fill="currentColor" />{/each}
	{/if}
</svg>

<style>
	.logo {
		display: block;
		flex: none;
	}
	.color {
		--trunk: #7a5b44;
		--leaf: #4a9443;
		--fruit: #f08a24;
		--eye: #fbf3e2;
	}
	:global(:root[data-theme="light"]) .color {
		--trunk: #5a4130;
		--leaf: #2f6d2d;
	}
	.trunk {
		fill: var(--trunk);
	}
	.leaf {
		fill: var(--leaf);
	}
	.fruit {
		fill: var(--fruit);
	}
	.color .eyes {
		fill: var(--eye);
	}
	.eyes path {
		transform-box: fill-box;
		transform-origin: center;
	}
	.blink .eyes path {
		animation: pipaya-blink 3s infinite;
	}
	/* closes 0.80-0.86s, reopens 0.88-0.98s; again 1.90-1.96s / 1.98-2.08s of 3s. */
	@keyframes pipaya-blink {
		0%, 26.667% { transform: scaleY(1); animation-timing-function: ease-in-out; }
		28.667%, 29.333% { transform: scaleY(0.07); animation-timing-function: ease-in-out; }
		32.667%, 63.333% { transform: scaleY(1); animation-timing-function: ease-in-out; }
		65.333%, 66% { transform: scaleY(0.07); animation-timing-function: ease-in-out; }
		69.333%, 100% { transform: scaleY(1); }
	}
	@media (prefers-reduced-motion: reduce) {
		.blink .eyes path {
			animation: none;
		}
	}
</style>
