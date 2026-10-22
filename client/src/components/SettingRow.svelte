<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * One line of a settings section: the label on the left, its control (Switch, Select, input, button) on the right.
	 * Replaces the `.row` / `.switch` flex rows that every settings panel used to restyle for itself.
	 *  - `for`: id of the control, when it is a field (makes the label click through to it);
	 *  - `dim`: the control is switched off by another setting, so the whole row fades (animated).
	 */
	let {
		label,
		for: forId,
		dim = false,
		children,
	}: {
		label: string;
		for?: string;
		dim?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="row" class:dim>
	{#if forId}<label for={forId}>{label}</label>{:else}<span>{label}</span>{/if}
	{@render children()}
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		font-size: var(--fs-md);
		line-height: 1.4;
		transition: opacity var(--motion-normal) var(--ease-std);
	}
	.row.dim {
		opacity: 0.45;
	}
	.row > :global(:not(label, span)) {
		flex: none;
	}
	label,
	span {
		min-width: 0;
		/* don't split a Korean word between syllables ("글/꼴") */
		word-break: keep-all;
	}
</style>
