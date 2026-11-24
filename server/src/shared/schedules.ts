/**
 * Scheduled-task validation limits shared by `server/src/scheduler.ts` and `client/src/lib/schedules.ts`.
 * Zero runtime dependencies so both sides validate against the exact same bounds.
 */
const DAY_MS = 86_400_000;

/** Pending tasks (everything except finished one-time tasks) at most. */
export const MAX_TASKS = 50;
/** Default number of days to keep finished one-time tasks before automatic deletion. */
export const DEFAULT_HISTORY_DAYS = 7;
export const MAX_HISTORY_DAYS = 365;
/** A finished one-time task is deleted this long after its last run (default). */
export const HISTORY_KEEP_MS = DEFAULT_HISTORY_DAYS * DAY_MS;
export const MIN_EVERY_MS = 5 * 60_000;
export const MAX_EVERY_MS = 30 * DAY_MS;
export const MAX_PROMPT = 8000;
export const MAX_TITLE = 100;
