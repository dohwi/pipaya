/**
 * Pure UX preference types, parsers, and click-resolution helpers.
 * Free of Svelte runes and DOM access so every edge case can be unit-tested.
 */

/** How clicking a session link/card/notice opens the session: quick-look modal ("peek") or direct navigation ("open"). */
export type SessionOpenMode = "peek" | "open";

/** Which desktop key combination sends a composer message ("enter" = Enter, "mod-enter" = Ctrl/⌘+Enter). */
export type SendKeyMode = "enter" | "mod-enter";

/** What pressing the primary send key while a run is active does ("steer" = inject mid-run, "queue" = follow up after). */
export type RunningEnterMode = "steer" | "queue";

/** In-app reduced motion preference ("system" follows OS prefers-reduced-motion; "on" forces reduced motion). */
export type ReducedMotionPref = "system" | "on";

export function parseSessionOpenMode(raw: unknown, fallback: SessionOpenMode): SessionOpenMode {
	return raw === "peek" || raw === "open" ? raw : fallback;
}

export function parseSendKeyMode(raw: unknown): SendKeyMode {
	return raw === "mod-enter" ? "mod-enter" : "enter";
}

export function parseRunningEnterMode(raw: unknown): RunningEnterMode {
	return raw === "queue" ? "queue" : "steer";
}

export function parseReducedMotionPref(raw: unknown): ReducedMotionPref {
	return raw === "on" ? "on" : "system";
}

export function parseMentionHover(raw: unknown): boolean {
	return raw !== false;
}

/**
 * Decide whether a session click should peek in the quick modal or navigate directly.
 *  - Holding the modifier (`Ctrl`/`⌘`, or `Shift+Enter` in graph) always triggers the opposite of `mode`.
 *  - Closed sessions stay safe on plain clicks: they always peek read-only unless `mod` is held to explicitly resume.
 */
export function resolveSessionOpen(
	mode: SessionOpenMode,
	mod: boolean,
	opts?: { closed?: boolean },
): SessionOpenMode {
	if (opts?.closed) return mod ? "open" : "peek";
	return mode === "open" ? (mod ? "peek" : "open") : (mod ? "open" : "peek");
}
