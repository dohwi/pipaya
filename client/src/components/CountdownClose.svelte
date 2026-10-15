<script lang="ts">
	import { t } from "../lib/i18n";
	import Icon from "./Icon.svelte";

	/** The close button on a strip: an X inside a ring that drains over `ms`, the time left before the strip goes away. */
	let { ms, onclick, label = t("알림 닫기") }: { ms: number; onclick: () => void; label?: string } = $props();
</script>

<button class="close" {onclick} aria-label={label}>
	<svg class="ring" viewBox="0 0 28 28" aria-hidden="true">
		<circle class="track" cx="14" cy="14" r="12" />
		<circle class="left" cx="14" cy="14" r="12" pathLength="100" style="animation-duration:{ms}ms" />
	</svg>
	<Icon name="x" />
</button>

<style>
	.close {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		color: var(--text-dim);
		/* the strip sets --tone (ok / error / ...); the ring takes it */
	}
	.close :global(svg:not(.ring)) {
		width: 13px;
		height: 13px;
		stroke: currentColor;
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.ring {
		position: absolute;
		inset: 4px;
		width: 28px;
		height: 28px;
		transform: rotate(-90deg);
	}
	.ring circle {
		fill: none;
		stroke-width: 2;
	}
	.track {
		stroke: var(--border-strong);
	}
	.left {
		stroke: var(--tone, var(--text-faint));
		stroke-linecap: round;
		stroke-dasharray: 100;
		stroke-dashoffset: 0;
		animation: drain linear forwards;
	}
	@keyframes drain {
		to {
			stroke-dashoffset: 100;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.left {
			animation-duration: 0.01ms !important;
		}
	}
</style>
