<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The one clickable pill: a tab, a filter, a shortcut. (A label that only displays something is a `Badge`.)
	 *
	 *  on       the selected one. Carries `aria-current` when `current` is set (tab rails), `aria-pressed` otherwise
	 *  size     sm (26px) for pickers, md (30px) for strips, lg (32px) for panel rails
	 *  The selected chip is filled (like a selected tab or nav row), not outlined: a dark ring is too loud at this size.
	 *  danger   draws an unselected chip in the danger colour
	 *
	 * The root is a real <button class="fchip">, so `slidingIndicator({ selector: ".fchip.on" })` and
	 * `rovingKeys({ item: ".fchip" })` can address every chip of this kind the same way.
	 */
	let {
		on = false,
		current = false,
		size = "md",
		danger = false,
		mono = false,
		title,
		onclick,
		children,
	}: {
		on?: boolean;
		/** Marks the selected chip with aria-current="page" (navigation) instead of aria-pressed (toggle). */
		current?: boolean;
		size?: "sm" | "md" | "lg";
		danger?: boolean;
		mono?: boolean;
		title?: string;
		onclick?: (e: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

<button
	type="button"
	class="fchip {size}"
	class:on
	class:danger
	class:mono
	{title}
	aria-current={current && on ? "page" : undefined}
	aria-pressed={current ? undefined : on}
	{onclick}
>{@render children()}</button>

<style>
	.fchip {
		position: relative;
		z-index: 0;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 46vw;
		padding: 0 11px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--bg);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		white-space: nowrap;
		cursor: pointer;
		transition:
			background var(--motion-fast) var(--ease-std),
			border-color var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std);
	}
	.sm {
		height: 26px; /* = Badge md + 4: a chip you can press sits a step above a label */
		padding: 0 10px;
		font-size: var(--fs-xs);
	}
	.md {
		height: 30px;
	}
	.lg {
		height: 32px;
		padding: 0 14px;
		gap: 8px;
		max-width: 260px;
	}
	.mono {
		font-family: var(--mono);
	}
	.fchip:hover {
		background: var(--bg-hover);
		border-color: var(--border-strong);
		color: var(--text);
	}
	.fchip.on {
		color: var(--text);
		border-color: var(--border-strong);
		background: var(--bg-active);
		font-weight: 600;
	}
	.danger:not(.on) {
		color: var(--danger);
		border-color: var(--danger);
	}
	/* when a sliding indicator is active it draws the selected fill behind the chips, so they go see-through */
	:global([data-indicator-ready]) .fchip {
		background: transparent;
	}
	:global([data-indicator-ready]) .fchip.on {
		border-color: transparent;
	}
	.fchip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
