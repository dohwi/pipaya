<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * One line of a settings section: the label on the left, its control (Switch, Select, input, button) on the right.
	 * Replaces the `.row` / `.switch` flex rows that every settings panel used to restyle for itself.
	 *  - `for`: id of the control, when it is a field (makes the label click through to it);
	 *  - `dim`: the control is switched off by another setting, so the whole row fades (animated).
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
	.row > :global(:not(.text)) {
		flex: none;
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		/* don't split a Korean word between syllables ("글/꼴") */
		word-break: keep-all;
	}
	.hint {
		line-height: 1.45;
	}
</style>
