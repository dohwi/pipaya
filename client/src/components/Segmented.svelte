<script lang="ts" generics="T extends string">
	import type { Snippet } from "svelte";
	import { slidingIndicator } from "../lib/sliding-indicator";
	import { rovingKeys } from "../lib/roving";

	/**
	 * One choice out of a few, with the sliding marker (lib/sliding-indicator.ts) and arrow keys (lib/roving.ts).
	 *  - `variant="fill"`: the compact pill track (`.seg` in app.css), for a mode switch;
	 *  - `variant="cards"`: equal-width outlined cards, for a setting (language, theme, approval).
	 * `tabs`: the options switch what is shown below (role=tablist/tab); otherwise they are a pressed-button group.
	 * `option` renders an option's inside when it needs more than its label (an icon).
	 */
	let {
		options,
		value,
		onchange,
		label,
		variant = "fill",
		tabs = false,
		full = true,
		size = "md",
		columns,
		option,
	}: {
		options: { id: T; label: string; disabled?: boolean; lang?: string }[];
		value: T;
		onchange: (id: T) => void;
		label: string;
		variant?: "fill" | "cards";
		tabs?: boolean;
		/** fill: stretch to the container's width */
		full?: boolean;
		size?: "sm" | "md";
		/** cards: how many per row (default: all options in one row) */
		columns?: number;
		option?: Snippet<[{ id: T; label: string }]>;
	} = $props();

	const indicator = $derived(
		variant === "cards"
			? { selector: "button.on", variant: "outline" as const, radius: "var(--radius)" }
			: { selector: "button.on", variant: "fill" as const, radius: "calc(var(--radius) - 3px)" },
	);
</script>

<div
	class={variant === "cards" ? "cards" : "seg"}
	class:full={variant === "fill" && full}
	class:sm={size === "sm"}
	style:--cols={columns ?? options.length}
	role={tabs ? "tablist" : "group"}
	aria-label={label}
	use:slidingIndicator={indicator}
	use:rovingKeys={{ item: "button" }}
>
	{#each options as o (o.id)}
		<button
			type="button"
			class:on={value === o.id}
			role={tabs ? "tab" : undefined}
			aria-selected={tabs ? value === o.id : undefined}
			aria-pressed={tabs ? undefined : value === o.id}
			tabindex={value === o.id ? 0 : -1}
			disabled={o.disabled}
			lang={o.lang}
			onclick={() => value !== o.id && onchange(o.id)}
		>
			{#if option}{@render option(o)}{:else}{o.label}{/if}
		</button>
	{/each}
</div>

<style>
	.cards {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: 8px;
	}
	.cards > button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 44px;
		padding: 0 8px;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: var(--bg-elev);
		transition:
			border-color var(--motion-fast) var(--ease-std),
			background-color var(--motion-fast) var(--ease-std);
	}
	.cards > button:hover:not(:disabled):not(.on) {
		border-color: var(--border-strong);
	}
	.cards > button.on {
		border-color: var(--text);
		background: var(--bg-active);
		font-weight: 600;
	}
	/* the sliding ring (drawn over the card) replaces the card's own border; the fill still cross-fades */
	.cards:global([data-indicator-ready]) > button.on {
		border-color: var(--border);
	}
	.cards > button :global(svg) {
		width: 17px;
		height: 17px;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
