export type DiffRow =
	| { kind: "ctx"; oldLine: number; newLine: number; text: string }
	| { kind: "del"; oldLine: number; newLine: null; text: string }
	| { kind: "add"; oldLine: null; newLine: number; text: string }
	| { kind: "skip"; count: number };

export interface LineDiff {
	rows: DiffRow[];
	added: number;
	removed: number;
}

const MAX_LCS_CELLS = 40_000;
const CONTEXT_LINES = 3;

const splitLines = (text: string): string[] => {
	if (!text) return [];
	return text.replace(/\r\n?/g, "\n").split("\n");
};

function collapseContext(raw: Exclude<DiffRow, { kind: "skip" }>[]): DiffRow[] {
	const hasChange = raw.some((r) => r.kind !== "ctx");
	if (!hasChange) return raw;

	const out: DiffRow[] = [];
	let i = 0;
	while (i < raw.length) {
		if (raw[i]!.kind !== "ctx") {
			out.push(raw[i]!);
			i++;
			continue;
		}
		let j = i;
		while (j < raw.length && raw[j]!.kind === "ctx") j++;
		const runLen = j - i;
		const atStart = i === 0;
		const atEnd = j === raw.length;
		const lead = atStart ? 0 : CONTEXT_LINES;
		const trail = atEnd ? 0 : CONTEXT_LINES;
		const skip = runLen - lead - trail;
		// Only collapse when hiding at least 3 unchanged lines; a "1 line hidden" row wastes space.
		if (skip >= 3) {
			for (let k = i; k < i + lead; k++) out.push(raw[k]!);
			out.push({ kind: "skip", count: skip });
			for (let k = j - trail; k < j; k++) out.push(raw[k]!);
		} else {
			for (let k = i; k < j; k++) out.push(raw[k]!);
		}
		i = j;
	}
	return out;
}

/**
 * Compute a unified line-by-line diff between `oldText` and `newText`.
 * Trims common prefix/suffix first, uses LCS on the changed middle (bounded by MAX_LCS_CELLS),
 * and collapses long unchanged context runs.
 */
export function computeLineDiff(oldText: string, newText: string): LineDiff {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	if (!a.length && !b.length) return { rows: [], added: 0, removed: 0 };

	// Trim common prefix
	let prefix = 0;
	const minLen = Math.min(a.length, b.length);
	while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

	// Trim common suffix (without overlapping prefix)
	let suffix = 0;
	while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

	const midA = a.slice(prefix, a.length - suffix);
	const midB = b.slice(prefix, b.length - suffix);

	const raw: Exclude<DiffRow, { kind: "skip" }>[] = [];
	for (let i = 0; i < prefix; i++) {
		raw.push({ kind: "ctx", oldLine: i + 1, newLine: i + 1, text: a[i]! });
	}

	let added = 0;
	let removed = 0;
	const m = midA.length;
	const n = midB.length;

	if (m === 0 && n === 0) {
		// Identical
	} else if (m === 0) {
		for (let j = 0; j < n; j++) {
			raw.push({ kind: "add", oldLine: null, newLine: prefix + j + 1, text: midB[j]! });
			added++;
		}
	} else if (n === 0) {
		for (let i = 0; i < m; i++) {
			raw.push({ kind: "del", oldLine: prefix + i + 1, newLine: null, text: midA[i]! });
			removed++;
		}
	} else if (m * n <= MAX_LCS_CELLS) {
		// Standard LCS DP table
		const cols = n + 1;
		const dp = new Uint16Array((m + 1) * cols);
		for (let i = m - 1; i >= 0; i--) {
			const rowOff = i * cols;
			const nextOff = (i + 1) * cols;
			for (let j = n - 1; j >= 0; j--) {
				dp[rowOff + j] = midA[i] === midB[j] ? dp[nextOff + j + 1]! + 1 : Math.max(dp[nextOff + j]!, dp[rowOff + j + 1]!);
			}
		}
		let i = 0;
		let j = 0;
		while (i < m && j < n) {
			if (midA[i] === midB[j]) {
				raw.push({ kind: "ctx", oldLine: prefix + i + 1, newLine: prefix + j + 1, text: midA[i]! });
				i++;
				j++;
			} else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
				raw.push({ kind: "del", oldLine: prefix + i + 1, newLine: null, text: midA[i]! });
				removed++;
				i++;
			} else {
				raw.push({ kind: "add", oldLine: null, newLine: prefix + j + 1, text: midB[j]! });
				added++;
				j++;
			}
		}
		while (i < m) {
			raw.push({ kind: "del", oldLine: prefix + i + 1, newLine: null, text: midA[i]! });
			removed++;
			i++;
		}
		while (j < n) {
			raw.push({ kind: "add", oldLine: null, newLine: prefix + j + 1, text: midB[j]! });
			added++;
			j++;
		}
	} else {
		// Fallback for huge edits: emit all deletions then all additions
		for (let i = 0; i < m; i++) {
			raw.push({ kind: "del", oldLine: prefix + i + 1, newLine: null, text: midA[i]! });
			removed++;
		}
		for (let j = 0; j < n; j++) {
			raw.push({ kind: "add", oldLine: null, newLine: prefix + j + 1, text: midB[j]! });
			added++;
		}
	}

	for (let k = 0; k < suffix; k++) {
		const oi = a.length - suffix + k;
		const ni = b.length - suffix + k;
		raw.push({ kind: "ctx", oldLine: oi + 1, newLine: ni + 1, text: a[oi]! });
	}

	return { rows: collapseContext(raw), added, removed };
}

/** Count lines in a string (0 for empty). */
export function lineCount(text: string): number {
	return splitLines(text).length;
}
