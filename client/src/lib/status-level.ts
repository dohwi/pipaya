/**
 * How worrying a number under the input is: "" = normal, "warn" = amber, "danger" = red.
 * The limits are in one place so they are easy to tune.
 */
export type Level = "" | "warn" | "danger";

/** Something that gets worse as it grows (context use %, cost): amber from `warn`, red from `danger`. */
export function high(n: number | null, warn: number, danger: number): Level {
	if (n === null || !Number.isFinite(n)) return "";
	return n >= danger ? "danger" : n >= warn ? "warn" : "";
}

/** Something that gets worse as it shrinks (cache hits, speed): amber below `warn`, red below `danger`. */
export function low(n: number | null, warn: number, danger: number): Level {
	if (n === null || !Number.isFinite(n)) return "";
	return n < danger ? "danger" : n < warn ? "warn" : "";
}

export const LIMITS = {
	/** % of the context window used */
	context: { warn: 20, danger: 40 },
	/** % of prompt tokens read from the cache; judged only once there are enough calls for it to mean something */
	cache: { warn: 60, danger: 30, minCalls: 3 },
	/** output tokens per second of the last answer */
	speed: { warn: 20, danger: 8 },
	/** accumulated cost of the conversation, in dollars */
	cost: { warn: 1, danger: 5 },
} as const;

export const contextLevel = (pct: number | null) => high(pct, LIMITS.context.warn, LIMITS.context.danger);
export const cacheLevel = (pct: number | null, calls: number) => (calls < LIMITS.cache.minCalls ? "" : low(pct, LIMITS.cache.warn, LIMITS.cache.danger));
export const speedLevel = (tps: number | null) => low(tps, LIMITS.speed.warn, LIMITS.speed.danger);
export const costLevel = (dollars: number) => high(dollars, LIMITS.cost.warn, LIMITS.cost.danger);
