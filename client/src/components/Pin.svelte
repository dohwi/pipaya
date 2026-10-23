<script lang="ts">
	import { syncAnim } from "../lib/syncAnim";

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
	 * The host can set `--pin-inset` (default -3px; a big tile uses 0 so the count stays inside it) and
	 * `--pin-ring` (the colour behind the host, default the sidebar's).
	 */
	let {
		tone = "neutral",
		count,
		pulse = false,
		ping = false,
		label,
	}: {
		tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "info";
		count?: number;
		pulse?: boolean;
		ping?: boolean;
		label?: string;
	} = $props();
</script>

<span
	class="pin {tone}"
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
		top: var(--pin-inset, -3px);
		right: var(--pin-inset, -3px);
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
	.num {
		width: auto;
		min-width: 12px;
		height: 14px;
		padding: 0 3px;
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
	.pulse {
		animation: pin-pulse 1.2s ease-in-out infinite;
	}
	.ping {
		animation: pin-ping 1.2s ease-in-out infinite;
	}
	@keyframes pin-pulse {
		50% {
			opacity: 0.4;
		}
	}
	@keyframes pin-ping {
		0% {
			box-shadow: 0 0 0 2px var(--pin-ring, var(--bg-side)), 0 0 0 2px var(--pin-bg);
		}
		70%,
		100% {
			box-shadow: 0 0 0 2px var(--pin-ring, var(--bg-side)), 0 0 0 7px transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse,
		.ping {
			animation: none;
		}
	}
</style>
