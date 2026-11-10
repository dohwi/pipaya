<script lang="ts">
	import Button from "./Button.svelte";
	import Icon from "./Icon.svelte";
	import { t } from "../lib/i18n";
	import { voice } from "../lib/voice.svelte";
	import { formatTime } from "../lib/voice";

	/**
	 * The composer while it records: the whole input becomes the recording surface instead of a one-line pill beside the
	 * microphone. The wave has room to read at a glance, the clock is large enough to see from across the desk, and the
	 * two answers (send it, throw it away) are where the send button sits when the box is a text field.
	 *
	 * It replaces the textarea and the toolbar, not the box: `Composer` keeps its border, its glow and its place, so
	 * starting or stopping a recording never moves the chat or the draft. The draft is not touched while recording —
	 * the transcript is inserted at the caret when the recording is over.
	 *
	 * The same panel covers transcribing: the recording is over, the answer is on its way, and the box stays the size
	 * the recording gave it instead of collapsing and growing again a moment later.
	 */
	let canvas = $state<HTMLCanvasElement | null>(null);
	let frame = 0;
	const PITCH = 6; // px between bar centres: a 3px bar and a 3px gap
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
			const bars = Math.max(8, Math.floor(w / PITCH)); // thin bars on a 6px pitch: the wave reads as a voice, not as ticks
			const step = Math.max(1, Math.floor(data.length / bars));
			if (levels.length !== bars) levels = new Array(bars).fill(0);
			g.strokeStyle = getComputedStyle(el).color;
			g.lineWidth = 3; // round caps make the 3px bars pills
			g.lineCap = "round";
			// A quiet microphone (a laptop's, a phone's, the fake device) barely moves the samples: amplify, then ease
			// the bar height towards the level so it reads as a voice and not as noise flicker.
			const floor = 2; // px: every bar is visible even in silence (a 4px dot at rest)
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

<div class="rec-panel" data-part="composer.recording" role="group" aria-label={t("음성 녹음")}>
	{#if voice.recording}
		<div class="head">
			<span class="mark"><span class="dot" aria-hidden="true"></span></span>
			<span class="label">{t("녹음 중")}</span>
			<span class="time" aria-label={t("녹음 중 {time}", { time: formatTime(voice.elapsed) })}>{formatTime(voice.elapsed)}</span>
		</div>
		<canvas bind:this={canvas} class="wave" aria-hidden="true"></canvas>
		<div class="actions">
			<button class="cancel tap" onclick={cancel} title={t("녹음 취소")} aria-label={t("녹음 취소")}>
				<Icon name="x" />
			</button>
			<Button onclick={stop} class="done">
				<Icon name="check" />
				{t("녹음 끝내기")}
			</Button>
		</div>
	{:else if voice.transcribing}
		<div class="head">
			<span class="mark"><span class="spinner" aria-hidden="true"></span></span>
			<span class="label" role="status" aria-live="polite">{t("변환 중…")}</span>
			<span class="time dim" aria-hidden="true">{formatTime(waited)}</span>
		</div>
		<div class="ghost" aria-hidden="true"></div>
		<div class="actions">
			<button class="cancel tap" onclick={cancelTranscribe} title={t("변환 취소")} aria-label={t("변환 취소")}>
				<Icon name="x" />
			</button>
			<span class="hint">{t("녹음을 글로 바꿔 입력창에 넣습니다")}</span>
		</div>
	{/if}
</div>

<style>
	/* One box, three bands: the status line, the wave that takes the room, the two answers on the toolbar's line. */
	.rec-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		/* 16px inline: the same inset the textarea's text has, so the dot, the clock and the answers sit on the text line */
		padding: 12px 16px 8px;
		/* head 28 + 8 + wave 56 + 8 + actions 38 + 20 padding: one height for recording and transcribing, so the box
		   never jumps between them (and it is 66px taller than the idle input, which is the room the wave needs) */
		min-height: 158px;
	}
	.head {
		display: flex;
		align-items: center;
		min-height: 28px;
	}
	.label {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-dim);
	}
	.time {
		margin-left: auto;
		font-size: var(--fs-lg);
		line-height: 28px;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.time.dim {
		font-size: var(--fs-sm);
		line-height: 20px;
		color: var(--text-faint);
	}
	/* One 16px slot for the mark, so the label starts on the same line whether the 8px dot or the 12px spinner is in
	   it (the two states must not shift the text). It starts at the slot's left edge, so the dot sits on the same line
	   as the wave below it; the slot carries the 8px between the mark and its label. */
	.mark {
		display: grid;
		place-items: center start;
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
	   with `height: auto` the browser derives the CSS height from those attributes — which grows the box every frame. */
	.wave {
		height: 56px;
		width: 100%;
		/* calm: the wave is the room's ink, red stays on the dot (the one "live" signal) */
		color: var(--text-dim);
	}
	/* Transcribing keeps the wave's footprint (same 56px, same 6px pitch) as a flat row of dots with a light passing
	   along it, so the box neither jumps nor sits empty while the answer is on its way. */
	.ghost {
		height: 56px;
		display: grid;
		align-items: center;
	}
	.ghost::before {
		content: "";
		height: 4px;
		mask-image: repeating-linear-gradient(90deg, #000 0 3px, transparent 3px 6px);
		background: linear-gradient(90deg, var(--border-strong) 0 35%, var(--text-dim) 50%, var(--border-strong) 65% 100%) 100% 0 / 300% 100%;
		animation: sweep 1.6s linear infinite;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.hint {
		margin-left: auto;
		font-size: var(--fs-xs);
		line-height: 20px;
		color: var(--text-faint);
	}
	.cancel {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		flex: none;
		margin-left: -9.5px; /* the glyph's own inset: puts the 19px x on the 16px text line, not 9.5px inside it */
		border-radius: 50%;
		color: var(--text-dim);
		background: transparent;
	}
	.cancel :global(svg) {
		width: 19px;
		height: 19px;
	}
	.cancel:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	/* The primary answer is the send button's twin: same 38px height and round 19px radius, on the toolbar's right line. */
	.actions :global(.btn.done) {
		margin-left: auto;
		/* quieter than the send button: a raised chip in the box's own tone, not a white slab */
		background: var(--bg-active);
		border-color: var(--border-strong);
		color: var(--text);
		height: 38px;
		border-radius: 19px;
		padding: 0 16px;
		gap: 8px;
	}
	.actions :global(.btn.done svg) {
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
		.ghost::before {
			animation: none;
		}
	}
</style>
