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
	const BAR = 3; // px: bar width
	const PITCH = 7; // px between bar centres: a 3px bar and a 4px gap, so the bars read one by one, not as a stripe
	const SAMPLE_MS = 60; // one bar per 60ms: the wave crosses a 300px row in about 6s
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

	// The wave is a level history: every SAMPLE_MS the microphone's loudness (RMS) joins on the right and the older ones
	// flow left, so it reads as "what you just said". Quiet is a line of dots, speech lifts the bars; the oldest fade out.
	// Under reduced motion the bars step instead of sliding.
	$effect(() => {
		if (!voice.recording || !canvas) return;
		const stream = voice.analyserStream();
		if (!stream) return;
		const context = new AudioContext();
		const node = context.createAnalyser();
		node.fftSize = 512;
		context.createMediaStreamSource(stream).connect(node);
		const data = new Uint8Array(node.fftSize);
		const history: number[] = [];
		let cur = 0;
		let last = performance.now();
		const draw = (now: number) => {
			const el = canvas;
			if (!el) return;
			const ratio = window.devicePixelRatio || 1;
			const w = el.clientWidth, h = el.clientHeight;
			if (el.width !== w * ratio || el.height !== h * ratio) { el.width = w * ratio; el.height = h * ratio; }
			const g = el.getContext("2d");
			if (!g) return;
			node.getByteTimeDomainData(data);
			let sum = 0;
			for (const v of data) sum += ((v - 128) / 128) ** 2;
			// RMS, lifted (a laptop or phone microphone is quiet) and capped; fast attack, slower release
			const target = Math.min(1, Math.pow(Math.sqrt(sum / data.length) * 6, 0.7));
			cur += (target - cur) * (target > cur ? 0.6 : 0.2);
			const sample = reduced ? SAMPLE_MS * 2 : SAMPLE_MS;
			while (now - last >= sample) { history.push(cur); last += sample; }
			const keep = Math.ceil(w / PITCH) + 2;
			while (history.length < keep) history.unshift(0);
			if (history.length > keep) history.splice(0, history.length - keep);
			const slide = reduced ? 0 : 1 - Math.min(1, (now - last) / sample); // 1 = the newest bar still to the right
			g.setTransform(ratio, 0, 0, ratio, 0, 0);
			g.clearRect(0, 0, w, h);
			g.strokeStyle = getComputedStyle(el).color;
			g.lineWidth = BAR;
			g.lineCap = "round"; // round caps turn the 3px bars into pills (and silence into dots)
			const reach = h / 2 - 2;
			for (let i = 0; i < history.length; i++) {
				const x = w - PITCH / 2 - (history.length - 1 - i) * PITCH + slide * PITCH;
				if (x < -BAR || x > w + BAR) continue;
				g.globalAlpha = Math.min(1, Math.max(0.15, x / 48)); // the left edge fades the oldest away
				const half = 1 + history[i]! * (reach - 1);
				g.beginPath();
				g.moveTo(x, h / 2 - half);
				g.lineTo(x, h / 2 + half);
				g.stroke();
			}
			g.globalAlpha = 1;
			frame = requestAnimationFrame(draw);
		};
		frame = requestAnimationFrame(draw);
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
		<span class="meta">
			<span class="label opt">{t("녹음 중")}</span>
			<span class="time" aria-label={t("녹음 중 {time}", { time: formatTime(voice.elapsed) })}>{formatTime(voice.elapsed)}</span>
		</span>
		<canvas bind:this={canvas} class="wave" aria-hidden="true"></canvas>
		<button class="done tap" onclick={stop} title={t("녹음 끝내기")} aria-label={t("녹음 끝내기")}>
			<Icon name="check" />
		</button>
	{:else if voice.transcribing}
		<span class="mark"><span class="spinner" aria-hidden="true"></span></span>
		<span class="meta">
			<span class="label" role="status" aria-live="polite">{t("변환 중…")}</span>
			<span class="time" aria-hidden="true">{formatTime(waited)}</span>
		</span>
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
	/* narrow pane: the toolbar's own narrow padding, so the box is still the idle height */
	@container (max-width: 480px) {
		.rec-row {
			gap: 4px;
			padding: 4px 4px 4px 3px;
		}
	}
	/* label + clock are one unit (8px apart); the row's gap separates the units */
	.meta {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex: none;
	}
	.label {
		font-size: var(--fs-sm);
		line-height: 20px;
		font-weight: 500;
		color: var(--text);
		white-space: nowrap;
	}
	.time {
		font-size: var(--fs-sm);
		line-height: 20px;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
		min-width: 32px; /* "0:04" never changes width, and "10:00" does not push the wave */
	}
	/* a phone's row is full: the dot and the clock say "recording", the word goes (it stays for screen readers) */
	@container (max-width: 480px) {
		.label.opt {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
	}
	/* the row arrives with a short fade and rise, so the swap from the toolbar is not a cut */
	.rec-row {
		animation: arrive var(--motion-fast, 150ms) var(--ease, ease-out);
	}
	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
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
		margin-right: 4px; /* the wave ends 4px before the finish button, the 8px gap + this = 12px of air */
		/* calm: the wave is the room's ink, red stays on the dot (the one "live" signal) */
		color: var(--text-dim);
	}
	/* Transcribing keeps the wave's footprint as a row of dots with a light passing along it. */
	.ghost {
		flex: 1;
		min-width: 0;
		height: 8px;
		margin-right: 8px; /* the dots end on the row's own 16px inset (8 + the row's 8), never at the box edge */
		/* round dots on the wave's 7px pitch: 3px across, centred in each cell */
		mask-image: radial-gradient(circle at 3.5px 50%, #000 1.5px, transparent 2px);
		mask-size: 7px 100%;
		mask-repeat: repeat-x;
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
	/* The finish button: the send button's twin in size (38px round) but a tint, not the accent slab, so "this is the answer" reads the same */
	.done {
		background: var(--accent-soft);
		color: var(--text);
	}
	.done:hover {
		background: var(--bg-active);
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
		.ghost,
		.rec-row {
			animation: none;
		}
	}
</style>
