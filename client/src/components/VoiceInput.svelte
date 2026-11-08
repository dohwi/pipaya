<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { voice } from "../lib/voice.svelte";
	import { FAILURE_TEXT, formatTime, TAP_MS } from "../lib/voice";

	/**
	 * The composer's microphone and its status pill. Shown only when voice input is on and its connection test passed
	 * (`voice.visible`), so a broken setting never leaves a dead button behind.
	 *
	 * Press: a tap toggles recording, a longer press records while held (the same "both" behaviour as the shortcut). The
	 * pill holds the elapsed time, a small waveform and cancel, and never covers the draft.
	 */
	/** The composer this button belongs to; "" on the new-chat screen, where the transcript goes to the open pane. */
	let { paneId }: { paneId: string } = $props();

	let pressedAt = 0;
	let holding = false;
	/** The hold started recording, so letting go stops it (a tap keeps recording until the next tap). */
	let holdRecords = false;
	let canvas = $state<HTMLCanvasElement | null>(null);
	let frame = 0;
	const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

	function down(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		voice.clearFailure();
		pressedAt = performance.now();
		holding = true;
		holdRecords = false;
	}

	async function up() {
		if (!holding) return;
		holding = false;
		const held = performance.now() - pressedAt;
		if (voice.recording) {
			// already recording (a tap started it): a short press stops it, a held press was the hold's own stop
			if (!holdRecords) voice.stop();
			holdRecords = false;
			return;
		}
		if (held >= TAP_MS) {
			// a long press records only while held
			holdRecords = true;
			const failure = await voice.start(paneId);
			if (failure) holdRecords = false;
			return;
		}
		const failure = await voice.start(paneId);
		if (failure) return;
	}

	function cancel() {
		holdRecords = false;
		voice.cancel();
	}

	// The waveform: a few bars from an AnalyserNode, drawn small inside the pill; static when motion is reduced.
	$effect(() => {
		if (!voice.recording || !canvas) return;
		const stream = voice.analyserStream();
		if (!stream) return;
		const context = new AudioContext();
		const node = context.createAnalyser();
		node.fftSize = 256;
		context.createMediaStreamSource(stream).connect(node);
		const draw = () => {
			const el = canvas;
			if (!el) return;
			const ratio = window.devicePixelRatio || 1;
			const w = el.clientWidth, h = el.clientHeight;
			if (el.width !== w * ratio || el.height !== h * ratio) { el.width = w * ratio; el.height = h * ratio; }
			const g = el.getContext("2d");
			if (!g) return;
			g.setTransform(ratio, 0, 0, ratio, 0, 0);
			g.clearRect(0, 0, w, h);
			const data = new Uint8Array(node.frequencyBinCount);
			node.getByteTimeDomainData(data);
			const bars = 7;
			const step = Math.floor(data.length / bars);
			g.strokeStyle = getComputedStyle(el).color;
			g.lineWidth = 2;
			g.lineCap = "round";
			for (let i = 0; i < bars; i++) {
				let peak = 0;
				for (let j = 0; j < step; j++) peak = Math.max(peak, Math.abs(data[i * step + j]! - 128) / 128);
				const x = (i + 0.5) * (w / bars);
				const half = Math.max(1.5, peak * (h / 2 - 1));
				g.beginPath();
				g.moveTo(x, h / 2 - half);
				g.lineTo(x, h / 2 + half);
				g.stroke();
			}
			frame = requestAnimationFrame(draw);
		};
		if (reduced) draw();
		else frame = requestAnimationFrame(draw);
		return () => {
			cancelAnimationFrame(frame);
			void context.close();
		};
	});
</script>

{#if voice.visible || voice.failure}
	<div class="voice">
		{#if voice.recording}
			<div class="pill rec" role="status" aria-live="polite">
				<span class="dot" aria-hidden="true"></span>
				<canvas bind:this={canvas} class="wave" aria-hidden="true"></canvas>
				<span class="time" aria-label={t("녹음 중 {time}", { time: formatTime(voice.elapsed) })}>{formatTime(voice.elapsed)}</span>
				<button class="act tap" onclick={cancel} title={t("녹음 취소")} aria-label={t("녹음 취소")}><Icon name="x" /></button>
			</div>
		{:else if voice.transcribing}
			<div class="pill busy" role="status" aria-live="polite">
				<span class="spinner" aria-hidden="true"></span>
				<span>{t("변환 중…")}</span>
			</div>
		{:else if voice.failure}
			<button class="pill error" role="status" onclick={() => voice.clearFailure()} title={t("닫기")}>
				<span>{t(FAILURE_TEXT[voice.failure])}</span>
			</button>
		{/if}
		{#if voice.visible}
		<button
			class="mic tap"
			class:rec={voice.recording}
			disabled={voice.transcribing}
			aria-label={voice.recording ? t("녹음 정지") : t("음성으로 입력")}
			aria-pressed={voice.recording}
			title={t("음성으로 입력 (짧게 누르면 시작/정지, 길게 누르면 누르는 동안)")}
			onpointerdown={down}
			onpointerup={up}
			onpointercancel={() => (holding = false)}
			onpointerleave={() => { if (voice.recording && !holdRecords) return; holding = false; }}
			onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void (voice.recording ? voice.stop() : voice.start(paneId)); } }}
		>
			<Icon name={voice.recording ? "stop" : "mic"} />
		</button>
		{/if}
	</div>
{/if}

<style>
	.voice {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: none;
		min-width: 0;
	}
	.mic {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex: none;
		border-radius: 50%;
		color: var(--text-dim);
		background: transparent;
	}
	.mic :global(svg) {
		width: 19px;
		height: 19px;
	}
	.mic:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.mic.rec {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 14%, transparent);
	}
	.mic:disabled {
		opacity: 0.4;
	}
	.pill {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 4px 0 12px;
		border-radius: 999px;
		background: var(--bg-active);
		color: var(--text-dim);
		font-size: var(--fs-xs);
		white-space: nowrap;
		min-width: 0;
		max-width: 320px;
	}
	.pill.rec {
		padding-right: 4px;
	}
	.pill.busy {
		padding-right: 12px;
	}
	.pill.error {
		padding-right: 12px;
		color: var(--danger);
	}
	.pill.error span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.time {
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.wave {
		width: 40px;
		height: 18px;
		color: var(--danger);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--danger);
		flex: none;
	}
	.spinner {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--border-strong);
		border-top-color: var(--text);
		animation: spin 0.8s linear infinite;
		flex: none;
	}
	.act {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		color: var(--text-dim);
	}
	.act :global(svg) {
		width: 14px;
		height: 14px;
	}
	.act:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
	/* a narrow pane keeps the toolbar on one line: the pill drops its text and only the time stays */
	@container (max-width: 480px) {
		.pill.error span,
		.pill.busy span:not(.spinner) {
			display: none;
		}
		.pill.error,
		.pill.busy {
			padding-right: 8px;
		}
		.wave {
			width: 28px;
		}
	}
</style>
