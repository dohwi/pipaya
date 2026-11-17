import { dayStart } from "./format";

/**
 * The local day it is now, as a rune, so "오늘" / "어제" in an open transcript move on at midnight without a reload.
 * A timer fires just after the next midnight; a page that slept through it (a phone in a pocket, a closed laptop)
 * checks again when it is shown.
 */
class Today {
	day = $state(dayStart(Date.now()));
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		if (typeof window === "undefined") return;
		this.arm();
		document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && this.check());
		window.addEventListener("focus", () => this.check());
	}

	private check() {
		const d = dayStart(Date.now());
		if (d !== this.day) this.day = d;
		this.arm();
	}

	private arm() {
		clearTimeout(this.timer);
		const next = new Date(this.day);
		next.setDate(next.getDate() + 1);
		this.timer = setTimeout(() => this.check(), Math.max(1000, next.getTime() - Date.now() + 1000));
	}
}

export const today = new Today();
