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
	 *  unit     small suffix after the value (`tps`)
	 *  more     a secondary count: folded behind the "more" button in a narrow pane
	 * Every item is the same 21px-tall box with a 4px icon/value gap, so the row aligns whatever it holds.
	 */
	let {
		icon,
		level = "",
		empty = false,
		title,
		label,
		unit,
		more = false,
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
		more?: boolean;
		onclick?: () => void;
		mark?: Snippet;
		children: Snippet;
	} = $props();
</script>

{#if onclick}
	<button class="b tap {level}" class:more class:empty onclick={onclick} aria-haspopup="dialog" aria-label={label} {title}>
		{@render inner()}
	</button>
{:else}
	<span class="b {level}" class:more class:empty role={label ? "group" : undefined} aria-label={label} {title}>
		{@render inner()}
	</span>
{/if}

{#snippet inner()}
	{#if mark}{@render mark()}{:else if icon}<Icon name={icon as never} />{/if}
	<span class="v">{@render children()}</span>{#if unit}<span class="unit">{unit}</span>{/if}
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
	/* no value yet: the dimmer token, not opacity (opacity .6 took the value to 2.3:1); --text-faint stays above 4.5:1 on the page */
	.empty {
		color: var(--text-faint);
	}
	.warn {
		color: var(--warn);
	}
	.danger {
		color: var(--danger);
	}
	.v {
		font-variant-numeric: tabular-nums;
		/* an extension's status text has no length limit: cut it so one item cannot push the rest off the row */
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.unit {
		font-size: var(--fs-xs);
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
	}
</style>
