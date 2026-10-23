<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	/**
	 * One row of a PickerModal list: name, a muted meta line, a check when selected, and an optional trailing control
	 * (a star) that reveals on hover. `disabled` rows stay focusable-looking but dimmed and are skipped by the arrows.
	 */
	let {
		selected = false,
		disabled = false,
		onclick,
		lead,
		name,
		meta,
		trailing,
	}: {
		selected?: boolean;
		disabled?: boolean;
		onclick: () => void;
		/** a logo or icon before the name */
		lead?: Snippet;
		name: Snippet;
		meta?: Snippet;
		trailing?: Snippet;
	} = $props();
</script>

<div class="pk-row" class:sel={selected}>
	<button type="button" class="pk-opt" class:dim={disabled} aria-pressed={selected} aria-disabled={disabled} onclick={() => !disabled && onclick()}>
		{#if lead}<span class="lead">{@render lead()}</span>{/if}
		<span class="main">
			<span class="name">{@render name()}</span>
			{#if meta}<span class="meta">{@render meta()}</span>{/if}
		</span>
		<span class="check" class:on={selected} aria-hidden="true"><Icon name="check" /></span>
	</button>
	{@render trailing?.()}
</div>

<style>
	.pk-row {
		display: flex;
		align-items: center;
		border-radius: var(--radius);
		transition: background-color var(--motion-fast) var(--ease-std);
	}
	.pk-row:hover:not(.sel) {
		background: var(--bg-hover);
	}
	.pk-row.sel {
		background: var(--bg-active);
	}
	.pk-opt {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		min-height: 44px;
		border-radius: var(--radius);
		text-align: left;
		transition: opacity var(--motion-fast) var(--ease-std);
	}
	.pk-opt:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.pk-opt.dim {
		opacity: 0.5;
		cursor: default;
	}
	.lead {
		flex: none;
		display: grid;
		place-items: center;
		width: 22px;
		color: var(--text-dim);
	}
	.main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.name {
		font-size: var(--fs-md);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: var(--fs-2xs);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* the check pops in instead of appearing */
	.check {
		display: grid;
		flex: none;
		opacity: 0;
		scale: 0.6;
		transition:
			opacity var(--motion-fast) var(--ease-std),
			scale var(--motion-fast) var(--ease);
	}
	.check.on {
		opacity: 1;
		scale: 1;
	}
	.check :global(svg) {
		width: 17px;
		height: 17px;
		stroke: var(--text);
		fill: none;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
