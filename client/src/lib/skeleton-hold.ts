/**
 * When a loading placeholder may give way to what it stands for.
 *
 * A skeleton fades in after `delay` (CSS `.skeleton-in`), so a load that ends before that is never seen and its content
 * shows at once. One that ends just after it would flash: bones for a few frames, then the content. Once the skeleton was
 * visible it is therefore kept for at least `min`, so the eye reads it as a stage rather than a flicker.
 *
 * `start`: when the skeleton was mounted; `now`: the current time. Returns how many ms are left to hold it (0 = swap now).
 */
export function skeletonHold(start: number, now: number, delay = SKELETON_DELAY_MS, min = SKELETON_MIN_MS): number {
	const shown = now - start - delay;
	if (shown <= 0) return 0; // never seen
	return Math.max(0, min - shown);
}

/** The skeleton's fade-in delay; keep in step with `.skeleton-in` in app.css. */
export const SKELETON_DELAY_MS = 150;
/** Least time a skeleton that became visible stays on screen. */
export const SKELETON_MIN_MS = 300;
