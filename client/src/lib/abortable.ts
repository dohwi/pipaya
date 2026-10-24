/**
 * One request an effect starts and the effect's cleanup cancels: the controller, the "ignore it if it was cancelled"
 * guard on every branch, and an optional delay (typing sends nothing until it pauses). Written out by hand it was ten
 * copies of the same six lines; the guard is the part that is easy to forget on one branch.
 *
 *   $effect(() => {
 *     const dep = ...;                                   // read what the request depends on here
 *     return abortable((signal) => api.skills(cwd, signal), { ok: (r) => (list = r), fail: () => (list = []) });
 *   });
 */
export interface AbortableOptions<T> {
	/** The request finished and nobody cancelled it */
	ok?: (value: T) => void;
	/** It failed and nobody cancelled it (a cancelled request never reports) */
	fail?: (error: unknown) => void;
	/** Runs after `ok` or `fail`, again only when not cancelled: where `loading = false` goes */
	done?: () => void;
	/** Wait this long before sending; cancelling during the wait sends nothing */
	delay?: number;
}

/** Start `run` and return the function that cancels it (hand that to `$effect` as its cleanup). */
export function abortable<T>(run: (signal: AbortSignal) => Promise<T>, opts: AbortableOptions<T> = {}): () => void {
	const controller = new AbortController();
	const { signal } = controller;
	const start = () => {
		run(signal)
			.then((value) => {
				if (!signal.aborted) opts.ok?.(value);
			})
			.catch((error) => {
				if (!signal.aborted) opts.fail?.(error);
			})
			.finally(() => {
				if (!signal.aborted) opts.done?.();
			});
	};
	if (!opts.delay) {
		start();
		return () => controller.abort();
	}
	const timer = setTimeout(start, opts.delay);
	return () => {
		clearTimeout(timer);
		controller.abort();
	};
}
