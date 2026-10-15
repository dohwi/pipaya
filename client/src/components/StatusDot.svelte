<script lang="ts">
	/**
	 * The one small status dot. `tone` says what it means, `pulse` that something is still happening,
	 * `size` is the diameter in px (8 by default; toasts and banners use 7).
	 */
	import { syncAnim } from "../lib/syncAnim";

	let {
		tone = "neutral",
		pulse = false,
		size = 8,
	}: {
		tone?: "neutral" | "ok" | "warn" | "danger" | "accent" | "info";
		pulse?: boolean;
		size?: number;
	} = $props();
</script>

<span class="dot {tone}" class:pulse style:width="{size}px" style:height="{size}px" aria-hidden="true" use:syncAnim={pulse}></span>

<style>
	.dot {
		flex: none;
		display: inline-block;
		border-radius: 50%;
		background: var(--dot, var(--text-faint));
	}
	.info {
		--dot: var(--info);
	}
	.ok {
		--dot: var(--ok);
	}
	.warn {
		--dot: var(--warn);
	}
	.danger {
		--dot: var(--danger);
	}
	.accent {
		--dot: var(--text);
	}
	.pulse {
		animation: dot-pulse 1.2s ease-in-out infinite;
	}
	@keyframes dot-pulse {
		50% {
			opacity: 0.3;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}
</style>
