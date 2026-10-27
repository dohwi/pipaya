/**
 * Reading JSON stored in a SQLite TEXT column. A row that was damaged (hand-edited database, a crash mid-write on an old
 * version) must cost that one row, not every list that happens to include it.
 */

/** Parsed value, or `fallback` when the text is not valid JSON. */
export function parseJson<T>(text: string, fallback: T): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

/** `rows.flatMap(...)` helper: the mapped row, or nothing when `map` throws (e.g. on a JSON.parse of a damaged column). */
export function mapRows<R, T>(rows: readonly R[], map: (row: R) => T, onSkip?: (row: R, error: unknown) => void): T[] {
	const out: T[] = [];
	for (const row of rows) {
		try {
			out.push(map(row));
		} catch (e) {
			onSkip?.(row, e);
		}
	}
	return out;
}
