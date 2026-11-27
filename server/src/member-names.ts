// Codename handles for sessions (`@name`): language-neutral lineage codes like A1, B1, A2, AA1.
// Independent sessions take the next free letter prefix (`A1`, `B1`, `C1`, ...); sessions spawned or forked from
// another session stay in the parent's prefix (`A2`, `A3`, ...).

/** Confusion-free uppercase letters (`I` and `O` excluded to avoid `1` / `0` ambiguity). */
export const CODENAME_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const CODENAME_RE = new RegExp(`^([${CODENAME_LETTERS}]+)([1-9]\\d*)$`, "i");

/** Bijective base-24 prefix sequence: 0 -> A, ..., 23 -> Z, 24 -> AA, 25 -> AB, ... */
export function codenamePrefix(index: number): string {
	let n = Math.max(0, Math.floor(index));
	let out = "";
	do {
		out = CODENAME_LETTERS[n % CODENAME_LETTERS.length]! + out;
		n = Math.floor(n / CODENAME_LETTERS.length) - 1;
	} while (n >= 0);
	return out;
}

/** Uppercase letter prefix of a valid codename (`A1` -> `A`, `ab12` -> `AB`), or `null` for non-codenames. */
export function codenamePrefixOf(name: string | null | undefined): string | null {
	if (!name) return null;
	const m = CODENAME_RE.exec(name);
	return m ? m[1]!.toUpperCase() : null;
}

/**
 * The next free codename given the names already in use (case-insensitive).
 * - With a codenamed `parentName` (e.g. `A1` or `A2`), stays in that family (`A2`, `A3`, ...).
 * - Otherwise picks the first letter prefix with no name in `taken` (`A1`, `B1`, ..., `Z1`, `AA1`, `AB1`, ...).
 */
export function nextMemberName(taken: ReadonlySet<string>, parentName?: string | null): string {
	const used = new Set<string>();
	const usedPrefixes = new Set<string>();
	for (const raw of taken) {
		const low = raw.toLowerCase();
		used.add(low);
		const prefix = codenamePrefixOf(raw);
		if (prefix) usedPrefixes.add(prefix);
	}

	const parentPrefix = codenamePrefixOf(parentName);
	if (parentPrefix) {
		for (let n = 1; ; n++) {
			const candidate = `${parentPrefix}${n}`;
			if (!used.has(candidate.toLowerCase())) return candidate;
		}
	}

	for (let i = 0; ; i++) {
		const prefix = codenamePrefix(i);
		if (usedPrefixes.has(prefix)) continue;
		const candidate = `${prefix}1`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
}

/** Canonical comparison key for a session or group handle: lower-cased so `@a1` and `@A1` are one name. */
export const nameKey = (name: string): string => name.toLowerCase();

/** Whether two written names mean the same session (case-insensitive). */
export const sameName = (a: string, b: string): boolean => nameKey(a) === nameKey(b);

/** What a group is called in a message: its name with whitespace turned into "-" so the tag stays one token. */
export const groupHandle = (name: string): string => name.trim().replace(/\s+/g, "-");

/**
 * The member a `@name` token starts with (case-insensitive): the longest known name, not cut out of
 * a longer ASCII word (Korean particles may follow: `@A1한테`). Returns the name as it is in `names`.
 */
export function memberAt(token: string, names: readonly string[]): string | null {
	const low = token.toLowerCase();
	let best: string | null = null;
	let bestLen = 0;
	for (const n of names) {
		const written = n.toLowerCase();
		if (!written || !low.startsWith(written) || written.length <= bestLen) continue;
		if (/[a-z0-9_-]$/.test(written) && /^[a-z0-9_-]/.test(low.slice(written.length))) continue;
		best = n;
		bestLen = written.length;
	}
	return best;
}

/** Names written as `@name` in a message, limited to known ones, in order of appearance, without repeats. */
export function mentioned(text: string, names: readonly string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const name = memberAt(m[1]!, names);
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}
