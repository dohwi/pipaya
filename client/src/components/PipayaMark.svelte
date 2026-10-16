<script lang="ts" module>
	/**
	 * pipaya mark for the sidebar / rail / empty states: the papaya tree with a square crown (5 fronds drooping to the sides,
	 * 2 big fruit) on a short, thick trunk, so it fills a 1:1 box and stays readable when small. No eyes, no animation.
	 * Geometry matches logo/build_mark.py (the app icon uses the same crown).
	 *  - `color`: two-tone artwork. Default is the single-colour mark (currentColor).
	 */
	let uid = 0;
</script>

<script lang="ts">
	let { color = false, size = 22 }: { color?: boolean; size?: number } = $props();

	const TRUNK = "M51 62H77L86 106H42Z";
	const LEAF = "M0 0C-13 -12 -13 -30 0 -46C13 -30 13 -12 0 0Z";
	const LEAF_K = 1.1;
	const FRONDS = [
		[-100, 0.9],
		[-50, 1.0],
		[0, 0.94],
		[50, 1.0],
		[100, 0.9],
	] as const;
	const FRUITS = [[55.5, 68], [72.5, 68]] as const;
	const R = 10.5;
	const KNOCK = 13.7;
	const mid = `pm${uid++}`;
</script>

<svg class="logo" class:color width={size} height={size} viewBox="15.22 11.44 97.56 97.56" role="img" aria-label="pipaya">
	<defs>
		<mask id={mid} maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256">
			<rect x="-64" y="-64" width="256" height="256" fill="#fff" />
			{#each FRUITS as [x, y]}<circle cx={x} cy={y} r={KNOCK} fill="#000" />{/each}
		</mask>
	</defs>
	<g mask="url(#{mid})">
		<path class="trunk" d={TRUNK} />
		<g class="leaf">
			<ellipse cx="64" cy="58" rx="6.5" ry="8.5" />
			{#each FRONDS as [angle, k]}
				<path d={LEAF} transform="translate(64 62) rotate({angle}) scale({LEAF_K} {LEAF_K * k})" />
			{/each}
		</g>
	</g>
	{#each FRUITS as [x, y]}<circle class="fruit" cx={x} cy={y} r={R} />{/each}
</svg>

<style>
	.logo {
		display: block;
		flex: none;
		--trunk: currentColor;
		--leaf: currentColor;
		--fruit: currentColor;
	}
	.color {
		--trunk: #7a5b44;
		--leaf: #4a9443;
		--fruit: #f08a24;
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
</style>
