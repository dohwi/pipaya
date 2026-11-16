import { SKELETON_DELAY_MS, skeletonHold } from "./skeleton-hold";

/** Longer than the content's fade-in (`.skeleton-out`, --motion-fast). */
const FADE_MS = 400;

/**
 * A component's skeleton, held on screen per `skeletonHold`: `showing` stays true for a moment after `loading()` turned
 * false when the skeleton had already become visible, and `revealed` tells the content to fade in (it replaces bones the
 * reader saw). A load faster than the skeleton's delay swaps at once and nothing fades.
 * Call during component setup (it registers effects).
 */
export function skeletonGate(loading: () => boolean): { readonly showing: boolean; readonly revealed: boolean } {
	let start = 0;
	let held = $state(false);
	let revealed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	// pre: decided before the DOM updates, so content never paints for a frame between the skeleton and its hold
	$effect.pre(() => {
		if (loading()) {
			if (!start) start = performance.now();
			return;
		}
		if (!start) return;
		const now = performance.now();
		const left = skeletonHold(start, now);
		const seen = now - start > SKELETON_DELAY_MS;
		start = 0;
		clearTimeout(timer);
		held = left > 0;
		revealed = seen;
		// the fade plays once: the class goes when it is done, so folding and unfolding later does not replay it
		if (seen) timer = setTimeout(() => ((held = false), (timer = setTimeout(() => (revealed = false), FADE_MS))), left);
	});
	$effect(() => () => clearTimeout(timer));
	return {
		get showing() {
			return loading() || held;
		},
		get revealed() {
			return revealed && !held;
		},
	};
}
