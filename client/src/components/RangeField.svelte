<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The one slider row: a short label, the track, the value on the right (fixed width so the track never jumps),
	 * and an optional trailing action (a reset). Used by the zoom, sound volume and auto-compaction settings.
	 *
	 *  oninput   every step while dragging; onchange once on release (save, preview a sound)
	 *  format    how the value is shown (default `N%`)
	 */
	let {
		label,
		value,
		min,
		max,
		step = 1,
		disabled = false,
		ariaLabel,
		format = (v: number) => `${v}%`,
		oninput,
		onchange,
		trailing,
		alignAction = false,
	}: {
		label: string;
		value: number;
		min: number;
		max: number;
		step?: number;
		disabled?: boolean;
		ariaLabel?: string;
		format?: (v: number) => string;
		oninput?: (v: number) => void;
		onchange?: (v: number) => void;
		trailing?: Snippet;
		/** keep the 88px action column so sibling sliders with and without actions share one track width */
		alignAction?: boolean;
	} = $props();
</script>

<div class="range" class:off={disabled} class:act={!!trailing || alignAction}>
	<label>
		<span class="name">{label}</span>
		<input type="range" {min} {max} {step} {value} {disabled} aria-label={ariaLabel ?? label} oninput={(e) => oninput?.(e.currentTarget.valueAsNumber)} onchange={(e) => onchange?.(e.currentTarget.valueAsNumber)} />
	</label>
	<output>{format(value)}</output>
	{#if trailing}<span class="tail">{@render trailing()}</span>{/if}
</div>

<style>
	.range {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 48px; /* track | value: the value is the row's right edge, like a switch or a field */
		align-items: center;
		gap: 8px;
		min-height: 36px; /* same row height with or without a trailing button */
		font-size: var(--fs-md);
		transition: opacity var(--motion-normal) var(--ease-std);
	}
	.range.off {
		opacity: 0.45;
	}
	label {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.name {
		flex: none;
	}
	input {
		flex: 1;
		min-width: 0;
		margin: 0;
	}
	.range.act {
		grid-template-columns: minmax(0, 1fr) 48px 88px; /* with an action: track | value | action (the action's right edge is the row's right edge) */
	}
	.tail {
		display: flex;
		justify-content: flex-end;
	}
	output {
		min-width: 0;
		text-align: right;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		color: var(--text-dim);
	}
</style>
