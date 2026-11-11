<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * A labelled field in a form: label (20px line) + 8px + the control. With a 40px control that is the 68px rhythm every
	 * dialog form keeps (`--dlg-gap-sm` between label and field). The control is the child; `label` is the text above it.
	 *  hint   one short line under the control
	 *  group  the control is not a single input (a Segmented): a <div> with a role=group instead of a <label>
	 * As a `<label>`, a click on the text focuses the first control inside.
	 */
	let { label, hint, group = false, children }: { label: string; hint?: string; group?: boolean; children: Snippet } = $props();
</script>

{#if group}
	<div class="ff" role="group" aria-label={label}>
		<span class="lab">{label}</span>
		{@render children()}
		{#if hint}<small class="hint">{hint}</small>{/if}
	</div>
{:else}
	<label class="ff">
		<span class="lab">{label}</span>
		{@render children()}
		{#if hint}<small class="hint">{hint}</small>{/if}
	</label>
{/if}

<style>
	.ff {
		display: flex;
		flex-direction: column;
		gap: var(--dlg-gap-sm);
		min-width: 0;
	}
	.lab {
		font-size: var(--fs-sm);
		line-height: 20px; /* whole-pixel label line: label 20 + gap 8 + field 40 = 68 */
		font-weight: 600;
		color: var(--text-dim);
	}
</style>
