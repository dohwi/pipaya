/** Given to sessions in order; the first one not taken by an active session is used. */
export const MEMBER_NAMES = ["철수", "미나", "제임스", "영희", "민준", "소피아", "지우", "에밀리", "하준", "루카", "서연", "토마스"];

/** The next free name given the lower-cased names in use: the pool first, then 철수2, 철수3, ... */
export function nextMemberName(taken: ReadonlySet<string>): string {
	const free = MEMBER_NAMES.find((n) => !taken.has(n.toLowerCase()));
	if (free) return free;
	for (let n = 2; ; n++) if (!taken.has(`${MEMBER_NAMES[0]}${n}`.toLowerCase())) return `${MEMBER_NAMES[0]}${n}`;
}

/** The member a `@name` token starts with: the longest known name, not cut out of a longer ASCII word (Korean particles may follow: @미나랑). */
export function memberAt(token: string, names: readonly string[]): string | null {
	const low = token.toLowerCase();
	let best: string | null = null;
	for (const n of names) {
		const l = n.toLowerCase();
		if (!low.startsWith(l) || (best && n.length <= best.length)) continue;
		if (/[a-z0-9_-]$/.test(l) && /^[a-z0-9_-]/.test(low.slice(l.length))) continue;
		best = n;
	}
	return best;
}

/** Names written as `@name` in a message, limited to known members, in order of appearance, without repeats. */
export function mentionedMembers(text: string, names: readonly string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const name = memberAt(m[1]!, names);
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/** Tells the model which sessions the user named, and how to reach them. */
export function memberHint(open: string, names: string[]): string {
	const list = names.map((n) => `@${n}`).join(", ");
	return `${open}The user mentioned ${list}: other sessions (agents) on this server. Use peer_send to give them work or ask them something (they run independently and see only what you send), and peer_read to look at what they said or did. Do not guess what they did.</pipaya-hint>`;
}
