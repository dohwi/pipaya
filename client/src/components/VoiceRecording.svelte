<script lang="ts">
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { voice } from "../lib/voice.svelte";
	import { formatTime } from "../lib/voice";

	/**
	 * The composer's toolbar row while it records or transcribes. It takes the place of the attach / model / send row and
	 * has the same height (4 + 38 + 8), so the box keeps the size it has when idle and the draft above it (read-only
	 * meanwhile) never moves: starting or stopping a recording changes one row, not the chat or the box.
	 *
	 * Recording:    [x cancel] ● Recording 0:04  [wave fills the rest]  [✓ finish]
	 * Transcribing: [x cancel] ◌ Transcribing… 0:03  [dots sweep]
	 */
	let canvas = $state<HTMLCanvasElement | null>(null);
	let frame = 0;
	const PITCH = 8; // px between bar centres: a 3px bar and a 5px gap, so the bars read one by one, not as a stripe
	/** Eased bar heights (0..1), so the wave moves smoothly instead of jumping with each frame's peak. */
	let levels: number[] = [];
	const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

	function stop() {
		voice.stop();
	}
	function cancel() {
		voice.cancel();
	}
	function cancelTranscribe() {
		voice.cancelTranscribe();
	}

	/** Seconds since the transcription began: it can take a while on a long recording, so the wait has a clock. */
	let waited = $state(0);
	$effect(() => {
		if (!voice.transcribing) return;
		waited = 0;
		const timer = setInterval(() => (waited = performance.now() - voice.transcribeStartedAt), 500);
		return () => clearInterval(timer);
	});

	// The wave: bars from an AnalyserNode, as many as the panel's width holds (the pill had room for seven; the panel
	// has the whole input, so the same 24px rhythm fills it and the wave reads as a voice, not as a few ticks). One
	// still frame under reduced motion.
	$effect(() => {
		if (!voice.recording || !canvas) return;
		const stream = voice.analyserStream();
		if (!stream) return;
		levels = [];
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
			const bars = Math.max(8, Math.floor(w / PITCH)); // 3px bars on an 8px pitch
			const step = Math.max(1, Math.floor(data.length / bars));
			if (levels.length !== bars) levels = new Array(bars).fill(0);
			g.strokeStyle = getComputedStyle(el).color;
			g.lineWidth = 3; // round caps make the 3px bars pills
			g.lineCap = "round";
			// A quiet microphone (a laptop's, a phone's, the fake device) barely moves the samples: amplify, then ease
			// the bar height towards the level so it reads as a voice and not as noise flicker.
			const floor = 2; // px: every bar is visible even in silence (a 4px nub at rest)
			const reach = h / 2 - 1;
			const x0 = (w - bars * PITCH) / 2 + PITCH / 2; // centred when the width is not a multiple of the pitch
			for (let i = 0; i < bars; i++) {
				let peak = 0;
				for (let j = 0; j < step; j++) peak = Math.max(peak, Math.abs(data[i * step + j]! - 128) / 128);
				// sqrt lifts quiet speech into view; the gain makes a laptop or phone microphone's small signal visible
				// without pinning loud speech to the top
				const level = Math.min(1, Math.pow(peak, 0.6) * 3);
				levels[i] = levels[i]! + (level - levels[i]!) * 0.35;
				const half = floor + levels[i]! * (reach - floor);
				const x = x0 + i * PITCH;
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

<div class="rec-row" data-part="composer.recording" role="group" aria-label={t("음성 녹음")}>
	<button class="cancel tap" onclick={voice.recording ? cancel : cancelTranscribe} title={voice.recording ? t("녹음 취소") : t("변환 취소")} aria-label={voice.recording ? t("녹음 취소") : t("변환 취소")}>
		<Icon name="x" />
	</button>
	{#if voice.recording}
		<span class="mark"><span class="dot" aria-hidden="true"></span></span>
		<span class="label">{t("녹음 중")}</span>
		<span class="time" aria-label={t("녹음 중 {time}", { time: formatTime(voice.elapsed) })}>{formatTime(voice.elapsed)}</span>
		<canvas bind:this={canvas} class="wave" aria-hidden="true"></canvas>
		<button class="done tap" onclick={stop} title={t("녹음 끝내기")} aria-label={t("녹음 끝내기")}>
			<Icon name="check" />
		</button>
	{:else if voice.transcribing}
		<span class="mark"><span class="spinner" aria-hidden="true"></span></span>
		<span class="label" role="status" aria-live="polite">{t("변환 중…")}</span>
		<span class="time" aria-hidden="true">{formatTime(waited)}</span>
		<span class="ghost" aria-hidden="true"></span>
	{/if}
</div>

<style>
	/* Same padding and 38px control height as the toolbar (`.bar` in Composer): the box does not change size. */
	.rec-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 8px 7px; /* the toolbar's own: the 19px glyph in its 38px button lands on the text line */
		min-width: 0;
	}
	.label {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
		white-space: nowrap;
	}
	.time {
		font-size: var(--fs-sm);
		line-height: 20px;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		min-width: 32px; /* "0:04" never changes width, and "10:00" does not push the wave */
	}
	/* One 16px slot for the mark, so the label starts on the same line whether the 8px dot or the 12px spinner is in it */
	.mark {
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		flex: none;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--danger);
	}
	.spinner {
		box-sizing: border-box; /* the 2px ring is part of the 12px, so it stays inside the 16px slot */
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--border-strong);
		border-top-color: var(--text);
		animation: spin 0.8s linear infinite;
	}
	/* A fixed height, not flex: the canvas sets its own width/height attributes from the box it is drawn into, and
	   with `height: auto` the browser derives the CSS height from those attributes, which grows the box every frame.
	   The wave takes the room the row leaves. */
	.wave {
		flex: 1;
		min-width: 0;
		height: 38px;
		/* calm: the wave is the room's ink, red stays on the dot (the one "live" signal) */
		color: var(--text-dim);
	}
	/* Transcribing keeps the wave's footprint as a row of dots with a light passing along it. */
	.ghost {
		flex: 1;
		min-width: 0;
		height: 4px;
		mask-image: repeating-linear-gradient(90deg, #000 0 3px, transparent 3px 8px);
		background: linear-gradient(90deg, var(--border-strong) 0 35%, var(--text-dim) 50%, var(--border-strong) 65% 100%) 100% 0 / 300% 100%;
		animation: sweep 1.6s linear infinite;
	}
	.cancel,
	.done {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex: none;
		border-radius: 50%;
	}
	.cancel {
		color: var(--text-dim);
		background: transparent;
	}
	.cancel:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	/* The finish button: the send button's twin (38px round, the accent) so "this is the answer" reads the same */
	.done {
		background: var(--accent);
		color: var(--accent-fg);
	}
	.done:hover {
		background: var(--accent-hover);
	}
	.cancel :global(svg),
	.done :global(svg) {
		width: 19px;
		height: 19px;
	}
	@keyframes sweep {
		to {
			background-position: 0 0;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner,
		.ghost {
			animation: none;
		}
	}
</style>
