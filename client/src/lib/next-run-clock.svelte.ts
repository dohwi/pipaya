import { nextLabelChange } from "./schedules";

/**
 * A clock for "when does it run next" labels (nextRunLabel): `now` moves only when one of the given times would change
 * its text, so a countdown under an hour ticks every minute on the minute and a far date does not wake the page at all.
 * Coming back to a hidden tab (whose timers the browser slowed down) reads the time again at once.
 * A `.svelte.ts` module: `now` is a rune. Call `follow()` from an `$effect`; it returns the effect's cleanup.
 */
export class NextRunClock {
	now = $state(Date.now());

	follow(times: readonly number[]): () => void {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			clearTimeout(timer);
			const wait = nextLabelChange(times, Date.now());
			if (wait !== null) timer = setTimeout(tick, wait);
		};
		const tick = () => {
			this.now = Date.now();
			arm();
		};
		const back = () => {
			if (document.visibilityState === "visible") tick();
		};
		this.now = Date.now();
		arm();
		document.addEventListener("visibilitychange", back);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", back);
		};
	}
}
