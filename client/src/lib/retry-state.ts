/** The "model call is being retried" state the server announces with `run_retrying`. */
export interface RetryState {
	attempt: number;
	maxRetries: number;
	/** Wait before the next try; 0 from an older server that did not send it */
	delayMs: number;
	/** Short cause (status code, ECONNREFUSED …); "" from an older server */
	reason: string;
	/** When the event arrived (ms since epoch): the countdown runs from here */
	at: number;
}

/** Reads a `run_retrying` payload; every field but attempt/maxRetries is optional (older servers omit them). */
export function parseRetrying(d: Record<string, unknown>, at: number): RetryState {
	const delay = Number(d.delayMs);
	return {
		attempt: Number(d.attempt) || 1,
		maxRetries: Number(d.maxRetries) || 1,
		delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
		reason: typeof d.reason === "string" ? d.reason.slice(0, 200) : "",
		at,
	};
}

/** Whole seconds until the next try, rounded up; 0 once it is due (or when the delay is unknown). */
export function secondsLeft(r: Pick<RetryState, "delayMs" | "at">, now: number): number {
	return Math.max(0, Math.ceil((r.at + r.delayMs - now) / 1000));
}
