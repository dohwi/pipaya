<script lang="ts">
	import PipayaMark from "../PipayaMark.svelte";
	import { t } from "../../lib/i18n";
</script>

<!-- Skeleton shown while an image model works: a quiet frame whose border carries a light travelling around it. -->
<div class="painting" role="status" aria-label={t("이미지를 만드는 중…")}>
	<div class="frame" aria-hidden="true">
		<span class="body">
			<span class="sheen"></span>
			<span class="mark"><PipayaMark size={56} /></span>
		</span>
		<span class="ring"></span>
	</div>
</div>

<style>
	@property --a {
		syntax: "<angle>";
		initial-value: 0deg;
		inherits: false;
	}
	.painting {
		width: min(100%, 360px);
		animation: appear var(--motion-normal) var(--ease) both;
	}
	.frame {
		position: relative;
		aspect-ratio: 1;
		overflow: hidden;
		border-radius: var(--radius);
		background: var(--bg-elev);
		isolation: isolate;
	}
	.body {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		overflow: hidden;
	}
	/* a soft diagonal band of light sweeping across the empty canvas, like a shimmer skeleton */
	.sheen {
		position: absolute;
		inset: -50% 0;
		background: linear-gradient(100deg, transparent 35%, color-mix(in srgb, var(--text) 9%, transparent) 50%, transparent 65%);
		transform: translateX(-100%) rotate(8deg);
		animation: sweep 2.4s ease-in-out infinite;
	}
	.mark {
		position: relative;
		display: grid;
		color: var(--text-dim);
		animation: breathe 2.4s ease-in-out infinite;
	}
	/* 1px border ring: a faint static line plus a comet of light travelling around it */
	.ring {
		position: absolute;
		inset: 0;
		padding: 1px;
		border-radius: inherit;
		background: conic-gradient(from var(--a), transparent 0deg, transparent 230deg, color-mix(in srgb, var(--text) 18%, transparent) 290deg, color-mix(in srgb, var(--text) 70%, transparent) 355deg, transparent 360deg), var(--border);
		mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
		mask-composite: exclude;
		animation: orbit 3.2s linear infinite;
	}
	@keyframes orbit {
		to {
			--a: 360deg;
		}
	}
	@keyframes sweep {
		to {
			transform: translateX(100%) rotate(8deg);
		}
	}
	@keyframes breathe {
		0%,
		100% {
			opacity: 0.45;
			transform: scale(0.94);
		}
		50% {
			opacity: 0.85;
			transform: scale(1);
		}
	}
	@keyframes appear {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.painting,
		.sheen,
		.mark,
		.ring {
			animation: none;
		}
	}
</style>
