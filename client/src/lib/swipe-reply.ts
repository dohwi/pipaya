/** Drag an answer right to left to reply to it (phones). */
export const SWIPE_TRIGGER = 64;
export const SWIPE_MAX = 96;

type Mode = "idle" | "pending" | "swipe" | "scroll";

/** Content with its own horizontal gestures or text input keeps them: a swipe never starts on these. */
export const SWIPE_BLOCKERS = "pre, table, .katex-display, input, textarea, [contenteditable]";

/**
 * The gesture as a small state machine, apart from the DOM: feed it the touches, read `x` (how far the card has
 * moved) and `armed` (let go now and it replies). A mostly vertical or rightward drag is a scroll and is left alone.
 */
export class SwipeReply {
	mode: Mode = "idle";
	/** Card offset in px (0 or negative: it follows the finger to the left, damped, up to SWIPE_MAX) */
	x = 0;
	armed = false;
	private x0 = 0;
	private y0 = 0;

	get swiping() {
		return this.mode === "swipe";
	}

	/** A touch began. `allowed` is false when replying is not possible here or the touch is on content that keeps its gestures. */
	start(touches: number, x: number, y: number, allowed: boolean) {
		if (touches !== 1 || !allowed) return void (this.mode = "scroll");
		this.x0 = x;
		this.y0 = y;
		this.mode = "pending";
	}

	/** The finger moved. Returns true when this move belongs to the swipe (the caller stops the page from scrolling). */
	move(x: number, y: number): { handled: boolean; justArmed: boolean } {
		if (this.mode === "idle" || this.mode === "scroll") return { handled: false, justArmed: false };
		const dx = x - this.x0;
		const dy = y - this.y0;
		if (this.mode === "pending") {
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return { handled: false, justArmed: false };
			if (Math.abs(dy) > Math.abs(dx) || dx > 0) {
				this.mode = "scroll";
				return { handled: false, justArmed: false };
			}
			this.mode = "swipe";
		}
		this.x = Math.max(-SWIPE_MAX, dx * 0.7);
		const hit = -this.x >= SWIPE_TRIGGER;
		const justArmed = hit && !this.armed;
		this.armed = hit;
		return { handled: true, justArmed };
	}

	/** The finger lifted: true when the swipe went far enough to reply. Always returns to rest. */
	end(): boolean {
		const reply = this.mode === "swipe" && this.armed;
		this.reset();
		return reply;
	}

	reset() {
		this.mode = "idle";
		this.armed = false;
		this.x = 0;
	}
}
