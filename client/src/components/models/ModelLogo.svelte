<script lang="ts">
	import PipayaMark from "../ui/PipayaMark.svelte";
	import { brandOf, BRAND_COLOR, PIPAYA_ICON, type Brand } from "../../lib/brand";
	import { BRAND_MARKS } from "../../lib/brand-marks";
	import { isImageIcon, loadIconImage, peekIconImage } from "../../lib/model-icon-image";
	import { app } from "../../lib/store.svelte";

	/**
	 * The logo of the model an agent runs on (the providers' official marks, drawn in currentColor).
	 * Models without a known mark fall back to the pipaya mark.
	 */
	let {
		provider,
		model,
		icon,
		conn,
		size = 20,
		colored = false,
	}: {
		provider?: string | null;
		model?: string | null;
		/** A brand chosen by the owner; wins over the guess from provider/model. */
		icon?: string | null;
		/** The server that holds an uploaded icon image; the open server when left out. */
		conn?: { baseUrl: string; token: string } | null;
		size?: number;
		/** Paint the mark in the provider's own colour instead of currentColor. */
		colored?: boolean;
	} = $props();

	// An icon seen before is drawn in the first frame (the dialog opens with it in place); only a new one waits for the fetch.
	const first = () => { const c = conn ?? app.conn; return icon && isImageIcon(icon) && c ? peekIconImage(c, icon) : null; };
	// svelte-ignore state_referenced_locally
	let imageUrl = $state<string | null>(first());
	$effect(() => {
		const c = conn ?? app.conn;
		if (!icon || !isImageIcon(icon) || !c) { imageUrl = null; return; }
		const hit = peekIconImage(c, icon);
		if (hit) { imageUrl = hit; return; }
		imageUrl = null;
		let live = true;
		void loadIconImage(c, icon).then((u) => { if (live) imageUrl = u; });
		return () => { live = false; };
	});

	const brand = $derived((icon && icon in BRAND_MARKS ? (icon as Brand) : brandOf(provider, model)));
</script>

{#if isImageIcon(icon)}
	{#if imageUrl}
		<img class="model img" src={imageUrl} width={size} height={size} alt="" />
	{:else}
		<span class="model img" style="width:{size}px;height:{size}px" aria-hidden="true"></span>
	{/if}
{:else if icon === PIPAYA_ICON || brand === null}
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
	.img {
		object-fit: contain;
		border-radius: 4px;
	}
</style>
