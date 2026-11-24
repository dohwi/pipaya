<script lang="ts" generics="T extends string">
	import type { Snippet } from "svelte";
	import { slidingIndicator } from "../../lib/sliding-indicator";
	import { rovingKeys } from "../../lib/roving";

	/**
	 * One choice out of a few, with the sliding marker (lib/sliding-indicator.ts) and arrow keys (lib/roving.ts).
	 *  - `variant="fill"`: the compact pill track (`.seg` in app.css), for a mode switch;
	 *  - `variant="ring"`: the same track with a hairline around the selection;
	 *  - `variant="cards"`: equal-width outlined cards, for a setting (language, theme);
	 *  - `variant="underline"`: text tabs over a hairline with a sliding 2px bar, for the sections of a page (use with `tabs`).
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
		options: { id: T; label: string; disabled?: boolean; lang?: string; tone?: "danger" | "warn"; /** the button's DOM id */ domId?: string; /** tabs: the id of the panel it shows */ controls?: string; title?: string }[];
		value: T;
		onchange: (id: T) => void;
		label: string;
		variant?: "fill" | "ring" | "cards" | "underline";
		tabs?: boolean;
		/** fill, underline: stretch to the container's width (underline: equal tabs; otherwise each as wide as its label) */
		full?: boolean;
		size?: "sm" | "md";
		/** cards: how many per row (default: all options in one row) */
		columns?: number;
		option?: Snippet<[{ id: T; label: string }]>;
	} = $props();

	const indicator = $derived(
		variant === "cards"
			? { selector: "button.on", variant: "outline" as const, radius: "var(--radius-control)", mirror: ["data-tone"] }
			: variant === "underline"
				? { selector: "button.on", variant, edge: "bottom" as const, thickness: 2 }
				: { selector: "button.on", variant, radius: size === "sm" ? "calc(var(--radius-control) - 3px)" : "calc(var(--radius) - 3px)" },
	);
	const box = $derived(variant === "cards" ? "cards" : variant === "underline" ? "utabs" : "seg");
</script>

<div
	class={box}
	class:full={variant !== "cards" && full}
	class:ring={variant === "ring"}
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
			id={o.domId}
			title={o.title}
			aria-controls={tabs ? o.controls : undefined}
			class:on={value === o.id}
			role={tabs ? "tab" : undefined}
			aria-selected={tabs ? value === o.id : undefined}
			aria-pressed={tabs ? undefined : value === o.id}
			tabindex={value === o.id ? 0 : -1}
			disabled={o.disabled}
			lang={o.lang}
			data-tone={o.tone}
			onclick={() => value !== o.id && onchange(o.id)}
		>
			{#if option}{@render option(o)}{:else}{o.label}{/if}
		</button>
	{/each}
</div>

<style>
	/* Keep the static ring until the sliding marker has measured its first position. */
	.ring:not(:global([data-indicator-ready])) > button.on {
		box-shadow: inset 0 0 0 1px var(--text-faint);
	}
	/* underline: the page's section tabs. The bar is the sliding marker; before it has measured, the selected tab draws its own. */
	.utabs {
		position: relative;
		display: flex;
		gap: 4px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
		box-shadow: inset 0 -1px 0 var(--border); /* the hairline under the tabs, drawn inside so a scrolling row does not clip the bar over it */
	}
	.utabs::-webkit-scrollbar {
		display: none;
	}
	.utabs > button {
		position: relative;
		z-index: 1;
		flex: none;
		height: 40px;
		padding: 0 12px;
		border-bottom: 2px solid transparent; /* the selected tab's bar covers the hairline */
		color: var(--text-dim);
		font-size: var(--fs-sm);
		font-weight: 550;
		white-space: nowrap;
		transition: color var(--motion-fast) var(--ease-std);
	}
	.utabs > button:focus-visible {
		outline-offset: -2px;
	}
	.utabs.full > button {
		flex: 1 0 auto;
	}
	@media (hover: hover) {
		.utabs > button:hover:not(:disabled) {
			color: var(--text);
		}
	}
	.utabs > button.on {
		color: var(--text);
		border-bottom-color: var(--ind-color, var(--text));
	}
	.utabs:global([data-indicator-ready]) > button.on {
		border-bottom-color: transparent;
	}
	.utabs > button:disabled {
		color: var(--disabled-fg);
	}
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
		height: var(--control-h);
		padding: 0 8px;
		border-radius: var(--radius-control);
		border: 1px solid var(--card-border, var(--border));
		background: var(--card-bg, var(--bg-elev));
		transition:
			border-color var(--motion-fast) var(--ease-std),
			background-color var(--motion-fast) var(--ease-std);
	}
	@media (hover: hover) {
		.cards > button:hover:not(:disabled):not(.on) {
			border-color: var(--border-strong);
		}
	}
	.cards > button.on {
		border-color: var(--text);
		background: var(--card-on-bg, var(--bg-active));
		font-weight: 600;
	}
	/* a risky choice (tone) turns its card red/amber when selected, so the danger is visible at a glance */
	.cards > button.on[data-tone="danger"] {
		color: var(--danger);
		background: var(--danger-soft);
	}
	.cards > button.on[data-tone="warn"] {
		color: var(--warn);
		background: var(--warn-soft);
	}
	/* the sliding ring (drawn over the card) replaces the card's own border; the fill still cross-fades */
	.cards:global([data-indicator-ready]) > button.on {
		border-color: var(--border);
	}
	.cards > button :global(svg) {
		width: 17px;
		height: 17px;
		stroke-width: 1.9;
	}
</style>
