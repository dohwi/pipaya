import { K, read, write } from "../persist";

/**
 * The composer's unsent text, kept on this device so it survives a restart. Per session ("" = new chat); only the text
 * and the message being replied to: pictures and files are blob URLs that do not outlive the page.
 */
export interface SavedDraft {
	text: string;
	reply: { text: string; who?: string } | null;
	/** Last change, ms since epoch: old drafts are dropped. */
	at: number;
}

export type SavedDrafts = Record<string, SavedDraft>;

/** A draft untouched this long is dropped. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many drafts are kept, the most recent first. */
export const MAX_DRAFTS = 50;
/** Text longer than this is not saved: it would crowd out the other settings in localStorage. */
export const MAX_CHARS = 100_000;

const isDraft = (v: unknown): v is SavedDraft => {
	if (!v || typeof v !== "object") return false;
	const d = v as Partial<SavedDraft>;
	return typeof d.text === "string" && typeof d.at === "number" && (d.reply === null || (typeof d.reply === "object" && typeof d.reply?.text === "string"));
};

/** Drop broken, empty, stale and surplus entries. Pure: returns a new object. */
export function pruneDrafts(all: unknown, now: number): SavedDrafts {
	if (!all || typeof all !== "object") return {};
	const kept = Object.entries(all as Record<string, unknown>)
		.filter((e): e is [string, SavedDraft] => isDraft(e[1]))
		.filter(([, d]) => (d.text.trim() || d.reply) && d.text.length <= MAX_CHARS && now - d.at < MAX_AGE_MS)
		.sort((a, b) => b[1].at - a[1].at)
		.slice(0, MAX_DRAFTS);
	return Object.fromEntries(kept);
}

let cache: SavedDrafts | null = null;
const all = (): SavedDrafts => (cache ??= pruneDrafts(read<unknown>(K.drafts, {}), Date.now()));

export function loadDraft(key: string): SavedDraft | null {
	return all()[key] ?? null;
}

/** Save (or, when there is nothing worth keeping, forget) the draft of `key`. Writes only when something changed. */
export function saveDraft(key: string, text: string, reply: SavedDraft["reply"]): void {
	const map = all();
	const prev = map[key];
	const keep = (text.trim() !== "" || reply !== null) && text.length <= MAX_CHARS;
	if (!keep) {
		if (!prev) return;
		delete map[key];
	} else {
		if (prev && prev.text === text && prev.reply?.text === reply?.text && prev.reply?.who === reply?.who) return;
		map[key] = { text, reply, at: Date.now() };
	}
	cache = pruneDrafts(map, Date.now());
	write(K.drafts, cache);
}

export function forgetDraft(key: string): void {
	saveDraft(key, "", null);
}

/** Tests only: drop the in-memory copy so the next call reads storage again. */
export function resetDraftCache(): void {
	cache = null;
}
