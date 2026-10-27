import { isTouch } from "./format";

/**
 * Focus a field as soon as it appears, but only where there is a hardware keyboard. On a touch screen focusing opens the
 * on-screen keyboard, which covers half of the sheet that just opened; there the user taps the field when they want it.
 * Use as `use:focusOnDesktop`, or `use:focusOnDesktop={false}` to skip it.
 */
export function focusOnDesktop(node: HTMLElement, enabled: boolean = true) {
	if (enabled && !isTouch()) queueMicrotask(() => node.focus({ preventScroll: true }));
}
