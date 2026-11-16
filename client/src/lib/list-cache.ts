/**
 * The last lists read from each server, kept in localStorage so a cold start draws the sidebar at once (stale-while-
 * revalidate): the link shows them until its first read replaces them. Only what the sidebar draws is kept (no activity:
 * a stale "working" dot would lie), and only for the same address and token (a fingerprint, never the token itself).
 * A cache, not a setting: it is not mirrored to durable storage and losing it costs one skeleton.
 */
import type { LinkData } from "./server-link-model";
import type { RepoInfo } from "./projects";
import type { TerminalInfo } from "./terminal";
import type { Group, Session, WorkspaceInfo } from "./types";

/** Not `pipaya.*`: those are settings, snapshotted to durable storage and restored; a cache must stay out of that. */
export const LIST_CACHE_KEY = "pipaya-cache.lists"; // per server: pipaya-cache.lists.<serverId>
const VERSION = 1;
/** The sidebar reads at most this many (the server's list is asked for 200). */
const MAX_SESSIONS = 200;
/** Older than this, the list is more likely wrong than helpful (a server not opened for weeks). */
const MAX_AGE_MS = 30 * 24 * 3600_000;

export interface ListCache {
	v: number;
	/** `fingerprint(baseUrl, token)` of the connection it was read through */
	fp: string;
	at: number;
	sessions: Session[];
	groups: Group[];
	terminals: TerminalInfo[];
	workspace: Pick<WorkspaceInfo, "root" | "home"> | null;
	/** Rows per top-level entry as the sidebar drew them (its header and the rows open under it), capped: see `shapeOf` */
	rows?: number[];
	/** The git repository of each folder, as the server last said (see ServerLink.repos) */
	repos?: Record<string, RepoInfo | null>;
}

/** A short, non-reversible tag of a connection (FNV-1a, 32 bits): enough to tell a changed address or token apart. */
export function fingerprint(baseUrl: string, token: string): string {
	let h = 0x811c9dc5;
	const s = `${baseUrl}\u0000${token}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

/** What to store: the lists without the per-session system prompt (long, and the sidebar never shows it). */
export function toCache(fp: string, d: Pick<LinkData, "sessions" | "groups" | "terminals">, ws: WorkspaceInfo | null, now: number, shape?: number[], repos?: Record<string, RepoInfo | null>): ListCache {
	// only the folders still listed: the map would otherwise keep every folder ever opened
	const cwds = new Set([...d.sessions.map((s) => s.cwd), ...d.terminals.map((x) => x.cwd)]);
	const kept = repos ? Object.fromEntries(Object.entries(repos).filter(([p]) => cwds.has(p))) : {};
	return {
		v: VERSION,
		fp,
		at: now,
		sessions: d.sessions.slice(0, MAX_SESSIONS).map((s) => ({ ...s, systemPrompt: "" })),
		groups: d.groups,
		terminals: d.terminals,
		workspace: ws ? { root: ws.root, ...(ws.home ? { home: ws.home } : {}) } : null,
		...(shape?.length ? { rows: shape.slice(0, SHAPE_DIRS).map((n) => Math.max(1, Math.min(n, SHAPE_TABS))) } : {}),
		...(Object.keys(kept).length ? { repos: kept } : {}),
	};
}

/** The stored lists if they belong to this connection and are recent and well-formed; null otherwise. */
export function fromCache(raw: unknown, fp: string, now: number): ListCache | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Partial<ListCache>;
	if (c.v !== VERSION || c.fp !== fp || typeof c.at !== "number" || now - c.at > MAX_AGE_MS || now < c.at - 60_000) return null;
	if (!Array.isArray(c.sessions) || !Array.isArray(c.groups) || !Array.isArray(c.terminals)) return null;
	if (!c.sessions.every((s) => s && typeof s.id === "string" && typeof s.cwd === "string" && typeof s.title === "string")) return null;
	// a malformed repository map only loses the grouping, not the lists
	if (c.repos !== undefined && !validRepos(c.repos)) return { ...(c as ListCache), repos: undefined };
	return c as ListCache;
}

function validRepos(v: unknown): v is Record<string, RepoInfo | null> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	return Object.values(v).every((r) => r === null || (!!r && typeof r === "object" && typeof (r as RepoInfo).root === "string" && typeof (r as RepoInfo).top === "string" && ((r as RepoInfo).branch === null || typeof (r as RepoInfo).branch === "string")));
}

const keyOf = (serverId: string) => `${LIST_CACHE_KEY}.${serverId}`;

export function readListCache(serverId: string, fp: string, now = Date.now()): ListCache | null {
	try {
		const raw = localStorage.getItem(keyOf(serverId));
		return raw ? fromCache(JSON.parse(raw), fp, now) : null;
	} catch {
		return null;
	}
}

export function writeListCache(serverId: string, c: ListCache): void {
	try {
		localStorage.setItem(keyOf(serverId), JSON.stringify(c));
	} catch {
		/* full or unavailable: the next cold start shows the skeleton, nothing else */
	}
}

export function dropListCache(serverId: string): void {
	try {
		localStorage.removeItem(keyOf(serverId));
	} catch {
		/* ignore */
	}
}

/** Most entries and rows per entry a skeleton draws (a header and up to four rows under it): enough to match the list's height, not so many it looks like content. */
const SHAPE_DIRS = 3;
const SHAPE_TABS = 5;

/**
 * How many rows each of the first entries had at the last visit, as the sidebar drew them. Counts only, so it is read
 * even when the copy itself cannot be used (another token, too old): the skeleton draws that many rows, and the card does
 * not jump when the real list lands.
 */
export function shapeOf(raw: unknown): number[] | null {
	if (!raw || typeof raw !== "object") return null;
	const s = (raw as Partial<ListCache>).rows; // `shape` (tabs per open folder) from before folders started folded is not read
	if (!Array.isArray(s) || !s.length || !s.every((n) => Number.isInteger(n) && n > 0)) return null;
	return s.slice(0, SHAPE_DIRS).map((n) => Math.min(n, SHAPE_TABS));
}

export function readShape(serverId: string): number[] | null {
	try {
		const raw = localStorage.getItem(keyOf(serverId));
		return raw ? shapeOf(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}
