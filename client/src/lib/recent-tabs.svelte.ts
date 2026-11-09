/**
 * Recently closed tabs, kept on this device: the conversations and terminals the user closed in the last hour, newest
 * first. Each folder of the sidebar lists its own (`forDir`), under its tabs and folded like a split tab, so a closed tab
 * comes back where it was rather than in one list away from the tree. A tab that is open again (reopened, or closed and
 * then resumed) leaves the list, and so does one that is deleted, so nothing is offered that is already there.
 *
 * The list is capped (`MAX`) and pruned by age on every read: nothing has to run on a timer for an old entry to go.
 */
import { K, read, write } from "./persist";

/** How long a closed tab is offered back. */
export const RECENT_TTL = 60 * 60 * 1000;
/** How many are kept on file (several folders can each show some). */
export const MAX_RECENT = 12;
/** How many one folder shows. */
export const MAX_PER_DIR = 3;

/** The fold key of one folder's recent list (`<serverId>\u0000<path>`): its own, so it opens and folds by itself. */
export const recentKey = (serverId: string, path: string) => `recent\u0000${serverId}\u0000${path}`;

export type RecentKind = "session" | "terminal";

/** A tab that was closed: enough to list it and to open it again. */
export interface RecentTab {
	/** The session or terminal id */
	id: string;
	kind: RecentKind;
	/** The server it lives on */
	serverId: string;
	/** Its title as it was when it closed */
	title: string;
	/** Where it worked, for the dim line and the tooltip */
	cwd: string;
	/** Unix ms of the close */
	at: number;
}

const isRecent = (v: unknown): v is RecentTab => {
	const o = v as RecentTab | null;
	return (
		!!o &&
		typeof o === "object" &&
		typeof o.id === "string" &&
		!!o.id &&
		(o.kind === "session" || o.kind === "terminal") &&
		typeof o.serverId === "string" &&
		!!o.serverId &&
		typeof o.title === "string" &&
		typeof o.cwd === "string" &&
		typeof o.at === "number" &&
		Number.isFinite(o.at)
	);
};

/** What is still worth offering: well-formed, newer than `RECENT_TTL`, newest first, at most `MAX_RECENT`. */
export function pruneRecent(list: readonly RecentTab[], now = Date.now()): RecentTab[] {
	return list
		.filter((x) => isRecent(x) && now - x.at < RECENT_TTL)
		.sort((a, b) => b.at - a.at)
		.slice(0, MAX_RECENT);
}

export class RecentTabs {
	/** Every closed tab still on file (pruned on read, so an expired entry never shows). */
	list = $state<RecentTab[]>(pruneRecent(read<RecentTab[]>(K.recentTabs, [])));

	/** The ones to show now: inside the hour, newest first, at most three. */
	get visible(): RecentTab[] {
		return pruneRecent(this.list);
	}

	/** What one folder on one server offers back: its own closed tabs, newest first, at most `MAX_PER_DIR`. */
	forDir(serverId: string, cwd: string): RecentTab[] {
		return this.visible.filter((x) => x.serverId === serverId && x.cwd === cwd).slice(0, MAX_PER_DIR);
	}

	/** The folders on one server with something to offer back: a folder with nothing open still shows for its list. */
	cwdsOf(serverId: string): string[] {
		return [...new Set(this.visible.filter((x) => x.serverId === serverId).map((x) => x.cwd))];
	}

	/** Remember a tab as just closed (the newest first; the same id never appears twice). */
	add(x: Omit<RecentTab, "at">, now = Date.now()) {
		this.save([{ ...x, at: now }, ...this.list.filter((y) => y.id !== x.id)]);
	}

	/** Drop a tab from the list: it is open again, or gone for good. */
	drop(id: string) {
		if (!this.list.some((x) => x.id === id)) return;
		this.save(this.list.filter((x) => x.id !== id));
	}

	/** Forget what belongs to a server that is no longer known. */
	keepServers(ids: readonly string[]) {
		const have = new Set(ids);
		if (this.list.every((x) => have.has(x.serverId))) return;
		this.save(this.list.filter((x) => have.has(x.serverId)));
	}

	private save(list: RecentTab[]) {
		this.list = pruneRecent(list);
		write(K.recentTabs, this.list);
	}
}
