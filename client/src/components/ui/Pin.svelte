<script lang="ts">
	import { syncAnim } from "../../lib/syncAnim";

	/**
	 * The one corner marker: a status dot or a count pinned to the top-right corner of its host.
	 * Every badge that sits on top of something (a folder tile, an agent logo, an icon, a chip) is a `Pin`, so they all
	 * share the corner, the ring and the shape. (Labels that sit in a row of text are a `Badge`; a dot in a row is a `StatusDot`.)
	 *
	 *  The host must be `position: relative`.
	 *  tone     meaning: neutral | accent | ok | warn | danger | info
	 *  count    shows the number (99+ above 99) instead of a dot
	 *  pulse    fades in and out: something is still happening
	 *  ping     sends a ring outwards: it needs the user
	 *  label    accessible name (omit when the host already says it)
	 *
	 * The host can set `--pin-inset` (default -3px; a big tile uses 0 so the count stays inside it),
	 * `--pin-top` / `--pin-right` (when an asymmetric icon's corner sits off the box edge), and
	 * `--pin-ring` (the colour behind the host, default the sidebar's).
	 */
	let {
		tone = "neutral",
		count,
		size = "md",
		pulse = false,
		ping = false,
		label,
	}: {
		tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "info";
		count?: number;
		size?: "md" | "sm";
		pulse?: boolean;
		ping?: boolean;
		label?: string;
	} = $props();
</script>

<span
	class="pin {tone}"
	class:sm={size === "sm" && count === undefined}
	class:num={count !== undefined}
	class:pulse
	class:ping
	role={label ? "img" : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : "true"}
	title={label}
	use:syncAnim={`${pulse}${ping}`}>{count !== undefined ? (count > 99 ? "99+" : count) : ""}</span
>

<style>
	.pin {
		position: absolute;
		top: var(--pin-top, var(--pin-inset, -3px));
		right: var(--pin-right, var(--pin-inset, -3px));
		z-index: 1;
		box-sizing: content-box;
		width: 8px;
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--pin-bg);
		color: var(--pin-fg);
		box-shadow: 0 0 0 2px var(--pin-ring, var(--bg-side));
		pointer-events: none;
		--pin-bg: var(--text-faint);
		--pin-fg: var(--bg-side);
	}
	.pin.sm {
		width: 6px; /* optical 6px dot for compact or low-profile glyphs (e.g. header folder icon) */
		height: 6px; /* optical 6px dot matching compact change indicators */
		box-shadow: 0 0 0 1.5px var(--pin-ring, var(--bg-side));
	}
	.num {
		/* one digit is a true circle; wider counts stretch into a pill */
		box-sizing: border-box;
		width: auto;
		min-width: 14px;
		height: 14px;
		padding: 0 4px;
		font-family: var(--mono);
		font-size: 9px;
		font-weight: 600;
		line-height: 14px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.neutral.num {
		--pin-bg: var(--bg-active);
		--pin-fg: var(--text-dim);
	}
	.accent {
		--pin-bg: var(--text);
	}
	.info {
		--pin-bg: var(--info);
	}
	.ok {
		--pin-bg: var(--ok);
	}
	.warn {
		--pin-bg: var(--warn);
	}
	.danger {
		--pin-bg: var(--danger);
	}
	/* the same slow breath as the agent logos (--anim-working-*), so pins and logos side by side stay calm and in step */
	.pulse {
		animation: pin-pulse var(--anim-working-duration) var(--anim-working-ease) infinite;
	}
	.ping {
		animation: pin-pulse var(--anim-working-duration) var(--anim-working-ease) infinite; /* the same calm breath: no expanding ring */
	}
	/* a pin breathes with its fill only: fading the whole pin made its ring see-through too, so the host's icon or tile
	   edge showed through the cut-out and the digits washed out; at the low point it read as neither there nor gone.
	   The ring and the digits stay solid. A dot sinks half way (the logos' --anim-working-dim); a count only to 75%,
	   which keeps its digits at 4.5:1 (dark) / 3.5:1 (light) on the fill. */
	.pulse,
	.ping {
		--pin-dim: 50%;
	}
	.num.pulse {
		--pin-dim: 75%;
	}
	@keyframes pin-pulse {
		50% {
			background-color: color-mix(in srgb, var(--pin-bg) var(--pin-dim), var(--pin-ring, var(--bg-side)));
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse,
		.ping {
			animation: none;
		}
	}
</style>
