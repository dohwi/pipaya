/** The pure halves of touch-hints.ts (no store, so the tests can load them). */

/** The hints already shown on this device (a list of keys). Pure so the test can drive it without storage. */
export function takeHint(seen: readonly string[], key: string): { show: boolean; seen: string[] } {
	return seen.includes(key) ? { show: false, seen: [...seen] } : { show: true, seen: [...seen, key] };
}

/** A tooltip as one line: its lines joined with " · " (a toast is one paragraph). */
export const tipLine = (title: string): string => title.trim().replace(/\s*\n\s*/g, " · ");
