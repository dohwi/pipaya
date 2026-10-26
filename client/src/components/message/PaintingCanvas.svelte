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
	.painting {
		width: min(100%, 320px);
	}
	.frame {
		position: relative;
		width: 100%;
		aspect-ratio: 1 / 1;
		overflow: hidden;
		border-radius: var(--radius);
		background: var(--bg-elev);
		isolation: isolate;
	}
	.body {
		position: absolute;
		inset: 1px;
		z-index: 1;
		border-radius: calc(var(--radius) - 1px);
		background: var(--bg-elev);
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
	/* the border: the frame's own 1px line, with a soft highlight gliding around it. A big rotating conic layer sits
	   behind the body; the body (inset 1px, opaque) covers all of it except the 1px edge. */
	.ring {
		position: absolute;
		inset: 0;
		overflow: hidden;
		border-radius: inherit;
		background: var(--border);
		z-index: 0;
	}
	.ring::before {
		content: "";
		position: absolute;
		left: 50%;
		top: 50%;
		width: 200%;
		aspect-ratio: 1;
		margin: -100% 0 0 -100%;
		background: conic-gradient(from 0deg, transparent 0deg, transparent 300deg, color-mix(in srgb, var(--text) 32%, transparent) 345deg, transparent 360deg);
		animation: orbit 3.2s linear infinite;
	}
	@keyframes orbit {
		to {
			transform: rotate(360deg);
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
	@media (prefers-reduced-motion: reduce) {
		.painting,
		.sheen,
		.mark,
		.ring::before {
			animation: none;
		}
	}
</style>
