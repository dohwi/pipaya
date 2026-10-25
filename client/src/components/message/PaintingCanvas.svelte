<script lang="ts">
	import Icon from "../Icon.svelte";
	import { t } from "../../lib/i18n";
</script>

<!-- Skeleton shown while an image model works: a quiet frame with a slow sheen and an indeterminate bar. -->
<div class="painting" role="status" aria-label={t("이미지를 만드는 중…")}>
	<div class="frame" aria-hidden="true">
		<span class="grid"></span>
		<span class="glow"></span>
		<span class="sheen"></span>
		<span class="mark"><Icon name="image" /></span>
		<span class="bar"></span>
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
	.frame {
		position: relative;
		aspect-ratio: 1;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		isolation: isolate;
		display: grid;
		place-items: center;
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
	/* one slow breathing highlight in the accent tone */
	.glow {
		position: absolute;
		inset: 20%;
		border-radius: 50%;
		background: radial-gradient(circle, color-mix(in srgb, var(--text) 10%, transparent), transparent 70%);
		will-change: transform, opacity;
		animation: breathe 3.6s ease-in-out infinite;
	}
	.sheen {
		position: absolute;
		inset: 0 auto 0 0;
		width: 45%;
		background: linear-gradient(100deg, transparent, color-mix(in srgb, var(--text) 7%, transparent), transparent);
		transform: translateX(-120%);
		will-change: transform;
		animation: sheen 2.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}
	.mark {
		position: relative;
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--bg);
		color: var(--text-dim);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
	}
	.mark :global(svg) {
		width: 22px;
		height: 22px;
	}
	.bar {
		position: absolute;
		inset: auto 0 0;
		height: 2px;
		overflow: hidden;
	}
	.bar::after {
		content: "";
		position: absolute;
		inset: 0 auto 0 0;
		width: 35%;
		background: var(--accent);
		opacity: 0.8;
		border-radius: 2px;
		will-change: transform;
		animation: slide 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}
	.cap {
		font-size: var(--fs-xs);
		align-self: flex-start;
	}
	@keyframes breathe {
		50% {
			transform: scale(1.18);
			opacity: 0.55;
		}
	}
	@keyframes sheen {
		60%,
		100% {
			transform: translateX(300%);
		}
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(290%);
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
		.glow,
		.sheen {
			animation: none;
		}
		.sheen {
			display: none;
		}
		.bar::after {
			animation: none;
			width: 40%;
		}
	}
</style>
