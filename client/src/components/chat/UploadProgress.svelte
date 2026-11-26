<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Spinner from "../ui/Spinner.svelte";
	import { t } from "../../lib/i18n";
	import { sizeLabel } from "../../lib/files";
	import type { SendingState } from "../../lib/store.svelte";

	/**
	 * The composer's toolbar row while an attachment upload is in flight. It replaces `.bar` with the exact same height
	 * (4 + 38 + 8) as VoiceRecording so the box never shifts, and lets the reader see byte progress or cancel a stalled
	 * upload without locking any other conversation.
	 *
	 * [x cancel] ◌ Uploading 42%  [━━━━━━░░░░░░]  1.8 / 4.2 MB
	 */
	let { state: upload, oncancel }: { state: SendingState; oncancel: () => void } = $props();

	const pct = $derived(upload.progress !== null ? Math.round(upload.progress * 100) : null);
	const indeterminate = $derived(upload.waiting || pct === null);
	const fillPct = $derived(pct !== null ? Math.max(4, pct) : 0);
</script>

<div class="up-row" role="group" aria-label={t("파일 업로드")}>
	<button class="cancel tap" onclick={oncancel} title={t("업로드 취소")} aria-label={t("업로드 취소")}>
		<Icon name="x" />
	</button>
	<span class="mark"><Spinner size={12} tone="muted" /></span>
	<span class="meta">
		<span class="label" role="status" aria-live="polite">{upload.waiting ? t("처리 중") : t("업로드 중")}</span>
		{#if !upload.waiting && pct !== null}
			<span class="pct">{pct}%</span>
		{/if}
	</span>
	<div
		class="track"
		role="progressbar"
		aria-label={t("파일 업로드")}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={indeterminate ? undefined : pct}
	>
		<div class="fill" class:indeterminate style:width={indeterminate ? undefined : `${fillPct}%`}></div>
	</div>
	{#if !upload.waiting && upload.total > 0}
		<span class="bytes">{sizeLabel(upload.loaded)} / {sizeLabel(upload.total)}</span>
	{/if}
</div>

<style>
	/* Same height as `.bar` and `VoiceRecording`: left 7px aligns the 19px cancel glyph in its 38px circle with the text gutter, right 16px matches the composer's right gutter. */
	.up-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 16px 8px 7px; /* optical: 7px aligns 19px glyph inside 38px button on the 16px text line */
		min-width: 0;
		animation: arrive var(--motion-fast, 150ms) var(--ease, ease-out);
	}
	@container (max-width: 480px) {
		.up-row {
			gap: 4px;
			padding: 4px 12px 4px 3px; /* optical: matches VoiceRecording narrow toolbar padding */
		}
		.bytes {
			display: none;
		}
	}
	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	.cancel {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex: none;
		border-radius: 50%;
		color: var(--text-dim);
		background: transparent;
	}
	@media (hover: hover) {
		.cancel:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}
	.cancel :global(svg) {
		width: 19px;
		height: 19px;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		flex: none;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}
	.label {
		flex: none;
		font-size: var(--fs-sm);
		line-height: 20px;
		font-weight: 500;
		color: var(--text);
		white-space: nowrap;
	}
	.pct {
		flex: none;
		font-size: var(--fs-sm);
		line-height: 20px;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
		min-width: 32px; /* "100%" never shifts the progress bar */
	}
	.track {
		flex: 1;
		min-width: 48px;
		height: 4px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
		position: relative;
	}
	.fill {
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
		transition: width var(--motion-fast) linear;
	}
	.fill.indeterminate {
		width: 40%;
		animation: slide 1.4s ease-in-out infinite;
	}
	.bytes {
		flex: none;
		font-size: var(--fs-xs);
		line-height: 20px;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
		white-space: nowrap;
	}
	@keyframes slide {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(350%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.up-row,
		.fill.indeterminate {
			animation: none;
		}
		.fill.indeterminate {
			width: 100%;
			opacity: 0.5;
		}
	}
</style>
