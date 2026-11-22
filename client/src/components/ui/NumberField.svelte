<script lang="ts">
	import type { ClassValue } from "svelte/elements";

	/**
	 * Shared numeric text box paired with `SettingRow` or `FormField`. Matches `--control-h-sm` and tabular digits so
	 * adjacent setting controls share height and visual weight.
	 */
	let {
		id,
		value = $bindable(),
		min,
		max,
		step,
		placeholder,
		ariaLabel,
		width,
		disabled = false,
		class: cls = "",
		onchange,
		oninput,
	}: {
		id?: string;
		value: number | string;
		min?: number;
		max?: number;
		step?: number | string;
		placeholder?: string;
		ariaLabel?: string;
		width?: string;
		disabled?: boolean;
		class?: ClassValue;
		onchange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
		oninput?: (e: Event & { currentTarget: HTMLInputElement }) => void;
	} = $props();
</script>

<input
	{id}
	type="number"
	class={["numfield", cls]}
	style:width={width}
	{min}
	{max}
	{step}
	{placeholder}
	{disabled}
	aria-label={ariaLabel}
	bind:value
	{onchange}
	{oninput}
/>

<style>
	.numfield {
		width: 96px;
		height: var(--control-h-sm);
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg);
		color: var(--text);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		font-variant-numeric: tabular-nums;
		transition:
			border-color var(--motion-fast) var(--ease-std),
			box-shadow var(--motion-fast) var(--ease-std);
	}
	.numfield:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}
</style>
