<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * One line of a settings section: the label on the left, its control (Switch, Select, input, button) on the right.
	 * Replaces the `.row` / `.switch` flex rows that every settings panel used to restyle for itself.
	 *  - `for`: id of the control, when it is a field (makes the label click through to it);
	 *  - `dim`: the control is switched off by another setting: the label goes faint and the control fades (animated).
	 *  - `hint`: one short line under the label saying what the setting does, kept next to the thing it explains.
	 */
	let {
		label,
		for: forId,
		dim = false,
		hint,
		children,
	}: {
		label: string;
		for?: string;
		dim?: boolean;
		hint?: string;
		children: Snippet;
	} = $props();
</script>

<div class="row" class:dim>
	<div class="text">
		{#if forId}<label for={forId}>{label}</label>{:else}<span>{label}</span>{/if}
		{#if hint}<small class="hint">{hint}</small>{/if}
	</div>
	{@render children()}
</div>

<style>
	.row {
		display: flex;
		flex-wrap: wrap; /* a wide control drops under its label instead of squeezing the label into a one-character column */
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		font-size: var(--fs-md);
		line-height: 20px; /* a whole-pixel line, so a row is 20 / 40 + padding on the scale */
		transition: color var(--motion-normal) var(--ease-std);
	}
	/* off because of another setting: the label and hint step down to the faint text colour and the control fades, so the
	   row reads as inactive. A 0.45 opacity over the whole row did that too, but left the label at 2.9:1 and its hint at
	   1.9:1, unreadable exactly where it says why the row is off. Now both stay 4.5:1 or better. */
	.row.dim .text {
		color: var(--text-faint);
	}
	.row > :global(:not(.text)) {
		flex: none;
		margin-left: auto;
		transition: opacity var(--motion-normal) var(--ease-std);
	}
	.row.dim > :global(:not(.text)) {
		opacity: 0.55;
	}
	.text {
		flex: 1 1 128px; /* keeps Korean labels and hints readable instead of squeezing into an 84px column beside a 3-option control */
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		/* don't split a Korean word between syllables ("글/꼴") */
		word-break: keep-all;
	}
	.hint {
		line-height: 16px;
	}
	/* phones: a segmented control or wide/editable Select stacks cleanly full-width below its label instead of floating right */
	@media (max-width: 640px) {
		.row:has(> :global(.seg)),
		.row:has(> :global(.sel.wide)) {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
		}
		.row:has(> :global(.seg)) > .text,
		.row:has(> :global(.sel.wide)) > .text {
			flex: none;
		}
		.row > :global(.seg) {
			display: grid;
			grid-auto-flow: column;
			grid-auto-columns: 1fr;
			width: 100%;
			margin-left: 0;
		}
		.row > :global(.sel.wide) {
			--sel-w: 100%;
			width: 100%;
			margin-left: 0;
		}
	}
</style>
