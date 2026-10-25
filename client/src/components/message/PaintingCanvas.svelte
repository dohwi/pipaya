<script lang="ts">
	import { t } from "../../lib/i18n";
</script>

<!-- Placeholder shown while an image model is still working: soft colour blobs drift and a brush band sweeps over. -->
<div class="painting" role="status" aria-label={t("이미지를 만드는 중…")}>
	<div class="canvas" aria-hidden="true">
		<span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span>
		<span class="sweep"></span>
	</div>
	<span class="shimmer cap">{t("이미지를 만드는 중…")}</span>
</div>

<style>
	.painting {
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: min(100%, 360px);
		animation: appear var(--motion-normal) var(--ease) both;
	}
	.canvas {
		position: relative;
		aspect-ratio: 1;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		isolation: isolate;
	}
	/* Gradients instead of filter: blur, so the animation only moves composited layers. */
	.orb {
		position: absolute;
		width: 90%;
		height: 90%;
		border-radius: 50%;
		background: radial-gradient(circle, var(--c) 0%, transparent 68%);
		opacity: 0.6;
		will-change: transform;
		animation: drift var(--d) ease-in-out infinite alternate;
	}
	.o1 {
		--c: #7c9cff;
		--d: 5.5s;
		left: -20%;
		top: -20%;
	}
	.o2 {
		--c: #e879b9;
		--d: 6.5s;
		right: -25%;
		top: 10%;
		animation-delay: -1.8s;
	}
	.o3 {
		--c: #5eead4;
		--d: 7.5s;
		left: 5%;
		bottom: -30%;
		animation-delay: -3.2s;
	}
	.sweep {
		position: absolute;
		inset: 0 auto 0 0;
		width: 60%;
		background: linear-gradient(105deg, transparent, color-mix(in srgb, var(--text) 14%, transparent), transparent);
		transform: translateX(-100%);
		will-change: transform;
		animation: sweep 2.6s ease-in-out infinite;
	}
	.cap {
		font-size: var(--fs-xs);
		align-self: flex-start;
	}
	@keyframes drift {
		to {
			transform: translate(28%, 22%) scale(1.2);
		}
	}
	@keyframes sweep {
		to {
			transform: translateX(170%);
		}
	}
	@keyframes appear {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.orb,
		.sweep,
		.painting {
			animation: none;
		}
		.sweep {
			display: none;
		}
	}
</style>
