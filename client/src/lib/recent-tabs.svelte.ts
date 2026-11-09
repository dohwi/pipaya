/**
 * Recently closed tabs, kept on this device: the conversations and terminals the user closed in the last hour, newest
 * first, so the sidebar can offer them back with one click. A tab that is open again (reopened, or closed and then
 * resumed) leaves the list, and so does one that is deleted, so the list never offers something that is already there.
 *
 * The list is capped (`MAX`) and pruned by age on every read: nothing has to run on a timer for an old entry to go.
 */
import { K, read, write } from "./persist";

/** How long a closed tab is offered back. */
export const RECENT_TTL = 60 * 60 * 1000;
/** How many are kept (and shown). */
export const MAX_RECENT = 3;

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
