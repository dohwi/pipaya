import { abortable } from "./abortable";

/**
 * A list that follows a query: while the query is `null` (or loading is not possible) it is empty; otherwise it is
 * fetched after a short pause, and a newer query cancels the one in flight. `for` says which query the rows belong to,
 * so a view can show nothing (not wrong rows) while the next query's answer is on its way; `loaded` says an answer,
 * even an empty or failed one, has arrived.
 *
 * A `.svelte.ts` module: the fields are runes. Call `follow()` from an `$effect`; it returns the effect's cleanup.
 */
export class DebouncedList<Q, T> {
	rows = $state<T[]>([]);
	/** The query `rows` answers; null before any answer */
	for = $state<Q | null>(null);
	loaded = $state(false);

	constructor(private readonly delay = 80) {}

	/** Fetch for `query` (null = nothing to ask: clear). `load` gets the abort signal. */
	follow(query: Q | null, load: ((query: Q, signal: AbortSignal) => Promise<T[]>) | null): (() => void) | void {
		if (query === null || !load) {
			this.rows = [];
			this.for = null;
			this.loaded = false;
			return;
		}
		return abortable((signal) => load(query, signal), {
			ok: (rows) => {
				this.rows = rows;
				this.for = query;
				this.loaded = true;
			},
			fail: () => {
				this.rows = [];
				this.for = query;
				this.loaded = true;
			},
			delay: this.delay,
		});
	}
}
