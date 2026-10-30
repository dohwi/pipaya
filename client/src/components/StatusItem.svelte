<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	/**
	 * One item of the line under the input: an icon (or a ring, via `icon`), a value and a tooltip, all on one baseline.
	 * With `onclick` it is a button that opens something (AGENTS.md, skills, MCP, commands); without it, plain text.
	 *
	 *  icon     name of the 13px line icon (11px in a narrow pane); a ring or other custom mark goes in `mark`
	 *  level    "" | "warn" | "danger": the colour of the whole item (context fill, cache hit, speed, failed servers)
	 *  empty    nothing to show yet: dimmed
	 *  label    accessible name of a button (the visible text is only the value)
	 *  unit     small suffix after the value, hidden on a phone (`tps`)
	 * Every item is the same 21px-tall box with a 4px icon/value gap, so the row aligns whatever it holds.
	 */
	let {
		icon,
		level = "",
		empty = false,
		title,
		label,
		unit,
		onclick,
		mark,
		children,
	}: {
		icon?: string;
		level?: "" | "warn" | "danger";
		empty?: boolean;
		title?: string;
		label?: string;
		unit?: string;
		onclick?: () => void;
		mark?: Snippet;
		children: Snippet;
	} = $props();
</script>

{#if onclick}
	<button class="b tap {level}" class:empty onclick={onclick} aria-haspopup="dialog" aria-label={label} {title}>
		{@render inner()}
	</button>
{:else}
	<span class="b {level}" class:empty {title}>
		{@render inner()}
	</span>
{/if}

{#snippet inner()}
	{#if mark}{@render mark()}{:else if icon}<Icon name={icon as never} />{/if}
	<span class="v">{@render children()}</span>{#if unit}<span class="unit wide">{unit}</span>{/if}
{/snippet}

<style>
	.b {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 0;
		font: inherit;
		color: inherit;
		white-space: nowrap;
		cursor: default;
		transition: color var(--motion-fast) var(--ease);
	}
	button.b {
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	button.b:hover {
		color: var(--text);
	}
	button.b:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.empty {
		opacity: 0.6;
	}
	.warn {
		color: var(--warn);
	}
	.danger {
		color: var(--danger);
	}
	.v {
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: var(--fs-2xs);
		opacity: 0.75;
	}
	.b :global(svg:not(.ring)) {
		width: 13px;
		height: 13px;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	@media (max-width: 640px) {
		.wide {
			display: none;
		}
	}
	/* narrow pane: smaller marks so the line stays on as few rows as possible */
	@container (max-width: 420px) {
		.b {
			gap: 4px;
		}
		/* the same selector as the base rule: a lower specificity would lose to it and leave 13px marks in a narrow pane */
		.b :global(svg:not(.ring)) {
			width: 11px;
			height: 11px;
		}
		.wide {
			display: none;
		}
	}
</style>
