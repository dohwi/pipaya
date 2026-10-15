// Notification sounds, synthesized (no audio files): a soft rising two-note "done", a two-tap "ask" that
// asks for attention, and a low descending "failed". Browsers only allow audio after a user gesture,
// so the context is created lazily and resumed on the first interaction.

export type Cue = "done" | "ask" | "failed";

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
	if (ctx) return ctx;
	const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!AC) return null;
	try {
		ctx = new AC();
	} catch {
		return null;
	}
	return ctx;
}

/** Call once; unlocks audio on the first tap/key so later cues (from background events) can play. */
export function armSound() {
	const unlock = () => {
		const c = context();
		if (c?.state === "suspended") void c.resume().catch(() => {});
	};
	for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, unlock, { passive: true });
}

// [frequency Hz, start s, duration s, peak gain]
const NOTES: Record<Cue, [number, number, number, number][]> = {
	done: [
		[659.25, 0, 0.16, 0.12], // E5
		[987.77, 0.1, 0.3, 0.12], // B5
	],
	ask: [
		[783.99, 0, 0.12, 0.14], // G5
		[783.99, 0.17, 0.12, 0.14],
		[1046.5, 0.34, 0.24, 0.14], // C6
	],
	failed: [
		[329.63, 0, 0.18, 0.13], // E4
		[246.94, 0.14, 0.36, 0.13], // B3
	],
};

export const MAX_VOLUME = 200;

/** Slider percent (0-200) -> gain multiplier. Squared so the slider feels even: 100% is the base loudness, 200% is 4x the amplitude (+12 dB). */
export function volumeGain(percent: number): number {
	const p = Math.min(MAX_VOLUME, Math.max(0, percent)) / 100;
	return p * p;
}

// Everything goes through one limiter, so a loud setting turns the overlap of two notes into
// a firmer sound instead of digital clipping.
let master: DynamicsCompressorNode | null = null;
function output(c: AudioContext): AudioNode {
	if (!master || master.context !== c) {
		master = c.createDynamicsCompressor();
		master.threshold.value = -10;
		master.knee.value = 6;
		master.ratio.value = 12;
		master.attack.value = 0.002;
		master.release.value = 0.12;
		master.connect(c.destination);
	}
	return master;
}

export function play(cue: Cue, volume = 1) {
	const c = context();
	if (!c || c.state !== "running") return;
	const t0 = c.currentTime + 0.01;
	for (const [freq, at, len, peak] of NOTES[cue]) {
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = cue === "failed" ? "triangle" : "sine";
		osc.frequency.value = freq;
		const s = t0 + at;
		gain.gain.setValueAtTime(0.0001, s);
		gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * volume), s + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, s + len);
		osc.connect(gain).connect(output(c));
		osc.start(s);
		osc.stop(s + len + 0.02);
	}
}
