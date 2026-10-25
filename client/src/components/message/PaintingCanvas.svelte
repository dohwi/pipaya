<script lang="ts">
	import PipayaMark from "../PipayaMark.svelte";
	import { t } from "../../lib/i18n";
</script>

<!-- Skeleton shown while an image model works: a quiet frame whose border carries a light travelling around it. -->
<div class="painting" role="status" aria-label={t("이미지를 만드는 중…")}>
	<div class="frame" aria-hidden="true">
		<span class="body">
			<span class="grid"></span>
			<span class="glow"></span>
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
	/* everything inside the border breathes together; the border itself stays crisp */
	.body {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		will-change: opacity;
		animation: fade 4.8s ease-in-out infinite;
	}
	/* faint blueprint grid, fading out toward the edges */
	.grid {
		position: absolute;
		inset: 0;
		background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px);
		background-size: 32px 32px;
		opacity: 0.45;
		mask-image: radial-gradient(circle at center, #000 0%, transparent 75%);
	}
	.glow {
		position: absolute;
		inset: 10%;
		border-radius: 50%;
		background: radial-gradient(circle, color-mix(in srgb, var(--text) 12%, transparent), transparent 70%);
	}
	.mark {
		position: relative;
		display: grid;
		color: var(--text-dim);
		opacity: 0.8;
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
	@keyframes fade {
		50% {
			opacity: 0.45;
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
		.body,
		.ring {
			animation: none;
		}
	}
</style>
