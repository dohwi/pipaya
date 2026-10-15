<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The one static label/badge. Use it for every small pill or tag that only displays a state or category
	 * (activity state, "this device", scope tags, diff kinds, queue mode). Clickable filters are not badges.
	 *
	 *  tone     meaning: neutral | ok | warn | danger | accent
	 *  variant  soft = tinted fill (default), outline = border only, solid = filled with the accent colour
	 *  size     sm (18px) for dense rows, md (22px, matches `.chip`)
	 *  mono     monospace face, for codes and counts
	 *  square   small radius instead of a full pill
	 */
	let {
		tone = "neutral",
		variant = "soft",
		size = "md",
		mono = false,
		square = false,
		minWidth,
		children,
	}: {
		tone?: "neutral" | "ok" | "warn" | "danger" | "accent" | "info";
		variant?: "soft" | "outline" | "solid";
		size?: "sm" | "md";
		mono?: boolean;
		square?: boolean;
		/** Keeps a column of badges the same width (e.g. diff kinds). */
		minWidth?: number;
		children: Snippet;
	} = $props();
</script>

<span class="badge {tone} {variant} {size}" class:mono class:square style:min-width={minWidth ? `${minWidth}px` : undefined}>{@render children()}</span>

<style>
	.badge {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		border-radius: var(--radius-pill);
		font-weight: 600;
		white-space: nowrap;
		color: var(--badge-fg);
		background: var(--badge-bg);
		border: 1px solid var(--badge-border, transparent);
		--badge-fg: var(--text-dim);
		--badge-bg: var(--bg-elev);
	}
	.md {
		height: 22px;
		padding: 0 9px;
		font-size: var(--fs-2xs);
		letter-spacing: 0.01em;
	}
	.sm {
		height: 18px;
		padding: 0 7px;
		font-size: var(--fs-2xs);
	}
	.square {
		border-radius: var(--radius-sm);
	}
	.mono {
		font-family: var(--mono);
	}

	/* tone -> colours */
	.info {
		--badge-fg: var(--info);
		--badge-bg: var(--info-soft);
	}
	.ok {
		--badge-fg: var(--ok);
		--badge-bg: var(--ok-soft);
	}
	.warn {
		--badge-fg: var(--warn);
		--badge-bg: var(--warn-soft);
	}
	.danger {
		--badge-fg: var(--danger);
		--badge-bg: var(--danger-soft);
	}
	.accent {
		--badge-fg: var(--text);
		--badge-bg: var(--accent-soft);
	}

	/* variants */
	.outline {
		background: transparent;
		--badge-border: var(--border-strong);
		font-weight: 500;
	}
	.outline.neutral {
		--badge-fg: var(--text-faint);
	}
	.outline.info,
	.outline.ok,
	.outline.warn,
	.outline.danger {
		--badge-border: currentColor;
	}
	.outline.accent {
		--badge-border: var(--text-faint);
	}
	.solid.accent {
		--badge-fg: var(--accent-fg);
		--badge-bg: var(--accent);
	}
	.solid.neutral {
		--badge-bg: var(--bg-active);
	}
</style>
