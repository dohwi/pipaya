<script lang="ts" module>
	/**
	 * pipaya mark for the sidebar / rail: the a-crop papaya tree (5 fronds, 2 big fruit), cropped tight so it stays readable when small.
	 * No eyes, no animation. Geometry matches logo/build_mark.py.
	 *  - `color`: two-tone artwork. Default is the single-colour mark (currentColor).
	 */
	let uid = 0;
</script>

<script lang="ts">
	let { color = false, size = 22 }: { color?: boolean; size?: number } = $props();

	const TRUNK = "M52 60H76L84 118H44Z";
	const LEAF = "M0 0C-11 -12 -11 -30 0 -46C11 -30 11 -12 0 0Z";
	const FRONDS = [
		[-80, 0.8],
		[-42, 0.95],
		[0, 1],
		[42, 0.95],
		[80, 0.8],
	] as const;
	const FRUITS = [56, 72] as const;
	const mid = `pm${uid++}`;
</script>

<svg class="logo" class:color width={size} height={size} viewBox="15 12 98 98" role="img" aria-label="pipaya">
	<defs>
		<mask id={mid} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
			<rect width="128" height="128" fill="#fff" />
			{#each FRUITS as x}<circle cx={x} cy="66" r="12.2" fill="#000" />{/each}
		</mask>
	</defs>
	<g mask="url(#{mid})">
		<path class="trunk" d={TRUNK} />
		<g class="leaf">
			<ellipse cx="64" cy="58" rx="6" ry="8" />
			{#each FRONDS as [angle, k]}
				<path d={LEAF} transform="translate(64 62) rotate({angle}) scale(1.05 {k * 1.05})" />
			{/each}
		</g>
	</g>
	{#each FRUITS as x}<circle class="fruit" cx={x} cy="66" r="9" />{/each}
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
