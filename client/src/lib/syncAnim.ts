/**
 * Svelte action: pins the element's CSS animations to the document timeline origin, so every pulsing dot
 * with the same duration blinks in lockstep no matter when it mounted or when its state changed.
 * Usage: `use:syncAnim={state}` (pass anything that changes when the animation may restart).
 */
export function syncAnim(node: HTMLElement, dep?: unknown) {
	const apply = () => {
		for (const a of node.getAnimations()) a.startTime = 0;
	};
	const run = (active?: unknown) => {
		if (active === false) return;
		queueMicrotask(apply);
		requestAnimationFrame(apply);
	};
	run(dep);
	return {
		update(next?: unknown) {
			run(next);
		},
	};
}
