<script lang="ts">
	import type { Snippet } from "svelte";

	/**
	 * The one static label/badge. Use it for every small tag that only displays a state or category
	 * (activity state, "this device", scope tags, diff kinds, queue mode). Clickable filters are not badges.
	 *
	 *  tone     meaning: neutral | ok | warn | danger | accent | info
	 *  variant  soft = tinted fill (default), outline = border only, solid = filled with the accent colour
	 *  size     sm (18px) for dense rows, md (22px, matches the model field's `.chip`)
	 *  mono     monospace face, for codes and counts
	 *  title    native tooltip on the badge itself (do not wrap `<Badge>` in a bare `<span>`, which breaks flex centring)
	 * Every badge uses `--radius-xs` (4px) rounded corners; round pills are kept for counters (`.cbadge`) and switches.
	 */
	let {
		tone = "neutral",
		variant = "soft",
		size = "md",
		mono = false,
		minWidth,
		title,
		children,
	}: {
		tone?: "neutral" | "ok" | "warn" | "danger" | "accent" | "info";
		variant?: "soft" | "outline" | "solid";
		size?: "sm" | "md";
		mono?: boolean;
		/** Keeps a column of badges the same width (e.g. diff kinds). */
		minWidth?: number;
		title?: string;
		children: Snippet;
	} = $props();
</script>

<span class="badge {tone} {variant} {size}" class:mono style:min-width={minWidth ? `${minWidth}px` : undefined} {title}>{@render children()}</span>

<style>
	.badge {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		max-width: 100%;
		overflow: hidden;
		border-radius: var(--radius-xs);
		font-weight: 600;
		white-space: nowrap;
		color: var(--badge-fg);
		background: var(--badge-bg);
		border: 0;
		--badge-fg: var(--text-dim);
		--badge-bg: var(--bg-active);
	}
	/* The font leaves more room below the baseline than above, so centred text sits ~0.5px low in a badge: 1px of bottom padding lifts it
	   by half that (measured at 8x on Hangul, Latin and digits: ink centre within 0.2px of the box centre). */
	.md {
		height: 22px;
		line-height: 16px; /* whole-pixel line box, not 1.55 (17.05px) */
		padding: 0 8px 1px;
		font-size: var(--fs-2xs);
		letter-spacing: 0.01em;
	}
	.sm {
		height: 18px;
		line-height: 16px; /* whole-pixel line box, not 1.55 (17.05px) */
		/* 6px horizontal inset keeps the 18px badge tighter than md without crowding the text */
		padding: 0 6px 1px;
		font-size: var(--fs-2xs);
	}
	/* even 12px icon in an even 18/22px badge; -1px gives back the badge's 1px bottom padding (which lifts text only) so the icon stays centred */
	.badge :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		margin-bottom: -1px;
		stroke-width: 2.4;
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
		border: 1px solid var(--badge-border, var(--border-strong));
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
