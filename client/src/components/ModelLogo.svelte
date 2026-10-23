<script lang="ts">
	import PipayaMark from "./PipayaMark.svelte";
	import { brandOf, BRAND_COLOR, PIPAYA_ICON, type Brand } from "../lib/brand";
	import { BRAND_MARKS } from "../lib/brand-marks";

	/**
	 * The logo of the model an agent runs on (the providers' official marks, drawn in currentColor).
	 * Models without a known mark fall back to the pipaya mark.
	 */
	let {
		provider,
		model,
		id,
		icon,
		size = 20,
		colored = false,
		bare = false,
	}: {
		provider?: string | null;
		model?: string | null;
		id?: string | null;
		/** A brand chosen by the owner; wins over the guess from provider/model. */
		icon?: string | null;
		size?: number;
		/** Paint the mark in the provider's own colour instead of currentColor. */
		colored?: boolean;
		/** Render nothing (rather than the pipaya mark) when the provider has no known mark. */
		bare?: boolean;
	} = $props();

	const brand = $derived((icon && icon in BRAND_MARKS ? (icon as Brand) : brandOf(provider, model)));
</script>

{#if icon === PIPAYA_ICON || brand === null}
	<PipayaMark {size} />
{:else}
	<svg class="model" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={brand} data-brand={brand} fill={colored ? BRAND_COLOR[brand] : "currentColor"} fill-rule={BRAND_MARKS[brand].evenodd ? "evenodd" : "nonzero"}>
		{#each BRAND_MARKS[brand].d as d}<path {d} />{/each}
	</svg>
{/if}

<style>
	.model {
		flex: none;
		display: block;
	}
</style>
