/**
 * Every reasoning strength a model can be asked for, weakest first.
 * Shared between `server/src/store.ts` and `client/src/lib/types.ts`.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
