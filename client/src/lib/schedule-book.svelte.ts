import { abortable } from "./abortable";
import { isUnsupportedRoute, type Api } from "./api";
import { NO_SCHEDULES, summarizeSchedules, type ScheduleSummary } from "./schedules";
import type { Schedule } from "./types";

/** Events come in bursts (a task runs, saves, runs again): read the list once after they pause. */
const PAUSE_MS = 300;

/**
 * The scheduled tasks of each server as the sidebar needs them (a count and a next time, per server and per
 * conversation), kept apart from the settings page, which reads its own list. A `.svelte.ts` module: the fields are runes.
 * Call `follow()` from an `$effect`; it returns the effect's cleanup.
 */
export class ScheduleBook {
	private lists = $state<Record<string, Schedule[]>>({});
	/** Servers that answered "no such route": older than the feature, so the sidebar hides it for them. */
	private unsupported = $state<Record<string, true>>({});

	/** Servers read at least once. Plain (not a rune): `follow` runs in an effect and must not depend on it. */
	private readonly read = new Set<string>();

	private readonly summaries = $derived.by(() => Object.fromEntries(Object.entries(this.lists).map(([id, list]) => [id, summarizeSchedules(list)] as const)));

	/** Switched-on tasks of the server, and the soonest next run. */
	all(serverId: string | null): ScheduleSummary {
		return (serverId && this.summaries[serverId]?.all) || NO_SCHEDULES;
	}
	/** Switched-on tasks of one conversation. */
	of(serverId: string, sessionId: string): ScheduleSummary {
		return this.summaries[serverId]?.bySession.get(sessionId) ?? NO_SCHEDULES;
	}
	/** False once the server turned out to be too old to have scheduled tasks. */
	supported(serverId: string | null): boolean {
		return !serverId || !this.unsupported[serverId];
	}

	/**
	 * Read the server's list. The first read is at once; later ones wait for the events to pause, and a newer call
	 * cancels the one waiting or in flight. Any other failure keeps what was shown (the next event tries again).
	 */
	follow(serverId: string | null, api: Api | null): (() => void) | void {
		if (!serverId || !api) return;
		return abortable((signal) => api.schedules(undefined, signal), {
			ok: (r) => {
				this.read.add(serverId);
				this.lists[serverId] = r.schedules;
				delete this.unsupported[serverId];
			},
			fail: (e) => {
				if (!isUnsupportedRoute(e)) return;
				this.read.add(serverId);
				this.lists[serverId] = [];
				this.unsupported[serverId] = true;
			},
			delay: this.read.has(serverId) ? PAUSE_MS : 0,
		});
	}
}
