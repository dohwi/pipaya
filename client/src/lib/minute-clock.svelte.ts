/**
 * The time of day for relative labels ("3분 전", "12분 후"), shared by the whole app: `now` moves once a minute, on the
 * minute, so every "N분 전" on screen turns over together instead of each list keeping its own interval. The timer runs
 * only while something reads `now` (createSubscriber), and a tab coming back from hidden (whose timers the browser
 * slowed down) reads the time at once.
 */
import { createSubscriber } from "svelte/reactivity";

class MinuteClock {
	#now = Date.now();
	#subscribe = createSubscriber((update) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			this.#now = Date.now();
			update();
			arm();
		};
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50); // just after the next whole minute
		};
		const back = () => {
			if (document.visibilityState === "visible") tick();
		};
		this.#now = Date.now();
		arm();
		document.addEventListener("visibilitychange", back);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", back);
		};
	});

	/** The current time, refreshed every minute while read in an effect or template. */
	get now(): number {
		this.#subscribe();
		return this.#now;
	}
}

export const minuteClock = new MinuteClock();
