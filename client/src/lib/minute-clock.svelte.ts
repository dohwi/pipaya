/**
 * The clock behind relative labels ("3분 전", "12분 후"), shared by the whole app.
 *
 * A label does not re-run every minute: it asks to be woken at the one clock minute its text next changes
 * (`pastChange` / `nextChange`), and the clock wakes only those. "12분 전" wakes next minute, "3시간 전" at the hour
 * it turns "4시간 전", "오후 2:05" only at midnight (`today`), and a message's "오후 2:05" never. A transcript of a
 * thousand messages costs a few label updates a minute, not a thousand.
 *
 * One timer, just after each whole minute, runs only while some label waits on it; a tab coming back from hidden
 * (whose timers the browser slowed or stopped) catches up at once.
 */
import { createSubscriber } from "svelte/reactivity";
import { messageTime, nextChange, pastChange, pastLabel, timeOfDay } from "./format";
import { localeTag } from "./i18n";
import { nextRunLabel } from "./schedules";
import { today } from "./today.svelte";

const MIN = 60_000;

/** A clock minute some labels wait for: reading `v` subscribes, bumping it re-runs them. */
class Slot {
	v = $state(0);
}

class MinuteClock {
	#slots = new Map<number, Slot>();
	#users = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#back = () => document.visibilityState === "visible" && this.#tick();

	/** Kept alive by whoever waits on a slot (created when the first label mounts, released with the last). */
	#keep = createSubscriber(() => {
		if (this.#users++ === 0) {
			this.#arm();
			document.addEventListener("visibilitychange", this.#back);
		}
		return () => {
			if (--this.#users > 0) return;
			clearTimeout(this.#timer);
			document.removeEventListener("visibilitychange", this.#back);
		};
	});

	#arm() {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#tick(), MIN - (Date.now() % MIN) + 50); // just after the next whole minute
	}

	/** Wake every label whose minute has come, then wait for the next minute. */
	#tick() {
		const m = Math.floor(Date.now() / MIN);
		for (const [k, s] of this.#slots) {
			if (k > m) continue;
			this.#slots.delete(k);
			s.v++;
		}
		if (this.#users > 0) this.#arm();
	}

	/** Re-run the reading template or $derived when clock minute `m` (minutes since the epoch) begins. */
	wakeAt(m: number) {
		this.#keep();
		let s = this.#slots.get(m);
		if (!s) this.#slots.set(m, (s = new Slot()));
		void s.v;
	}

	/** How many minutes are waited on now (tests and diagnostics). */
	get waiting(): number {
		return this.#slots.size;
	}
}

export const minuteClock = new MinuteClock();

/** A past time that keeps itself current (pastLabel): use it in a template or $derived. */
export function livePast(ts: number, opts: { time?: boolean } = {}): string {
	const now = Date.now();
	const m = pastChange(ts, now);
	if (m !== null) minuteClock.wakeAt(m);
	else void today.day; // "오후 2:05" turns "어제" at midnight, "어제" turns a weekday
	return pastLabel(ts, now, opts);
}

/** A message's time that keeps itself current (messageTime): relative while recent, then fixed for good. */
export function liveMessageTime(ts: number): string {
	const now = Date.now();
	const m = pastChange(ts, now);
	if (m === null) return timeOfDay(ts, localeTag());
	minuteClock.wakeAt(m);
	return messageTime(ts, now);
}

/** A future time that keeps itself current (nextRunLabel): counts down by the minute within 6 hours. */
export function liveNext(ts: number): string {
	const now = Date.now();
	const m = nextChange(ts, now);
	if (m !== null) minuteClock.wakeAt(m);
	void today.day; // "내일 오전 9:00" turns "오전 9:00" at midnight
	return nextRunLabel(ts, now);
}
