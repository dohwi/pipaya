/**
 * Svelte action: pins the element's CSS animations to the document timeline origin, so every pulsing dot
 * with the same duration blinks in lockstep no matter when it mounted or when its state changed.
 * Usage: `use:syncAnim={state}` (pass anything that changes when the animation may restart).
 */
export function syncAnim(node: HTMLElement, _dep?: unknown) {
	const apply = () => {
		for (const a of node.getAnimations()) a.startTime = 0;
	};
	queueMicrotask(apply);
	requestAnimationFrame(apply);
	return {
		update() {
			queueMicrotask(apply);
			requestAnimationFrame(apply);
		},
	};
}
