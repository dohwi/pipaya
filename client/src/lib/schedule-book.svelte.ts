import { abortable } from "./abortable";
import { isUnsupportedRoute, type Api } from "./api";
import { NO_SCHEDULES, composerSchedules, summarizeSchedules, type ScheduleSummary } from "./schedules";
import type { Schedule } from "./types";

/** Events come in bursts (a task runs, saves, runs again): read the list once after they pause. */
const PAUSE_MS = 300;
/** Backoff delays (ms) when a transient read fails while the server is still online. */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export interface FollowOpts {
	/** Skip the burst debounce (used on initial connect and full server reconnect/update). */
	immediate?: boolean;
	/** While this returns true, transient (non-404) failures retry with bounded backoff. */
	retry?: () => boolean;
}

/**
 * The scheduled tasks of each server as the sidebar needs them (a count and a next time, per server and per
 * conversation), kept apart from the settings page, which reads its own list. A `.svelte.ts` module: the fields are runes.
 * Tracks every server independently; calling `follow()` again for a server cancels its previous pending read/retry.
 */
export class ScheduleBook {
	private lists = $state<Record<string, Schedule[]>>({});
	/** Servers that answered "no such route": older than the feature, so the sidebar hides it for them. */
	private unsupported = $state<Record<string, true>>({});

	/** Servers read at least once. Plain (not a rune): `follow` may run in an effect and must not depend on it. */
	private readonly read = new Set<string>();
	/** Servers whose cached list is waiting for a debounced refetch after `schedules_updated`. */
	private readonly stale = new Set<string>();
	private readonly controllers = new Map<string, () => void>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly retryAttempts = new Map<string, number>();
	private readonly gens = new Map<string, number>();
	private readonly pauseMs: number;
	private readonly retryDelays: readonly number[];

	constructor(opts?: { pauseMs?: number; retryDelays?: readonly number[] }) {
		this.pauseMs = opts?.pauseMs ?? PAUSE_MS;
		this.retryDelays = opts?.retryDelays ?? RETRY_DELAYS_MS;
	}

	private readonly summaries = $derived.by(() => Object.fromEntries(Object.entries(this.lists).map(([id, list]) => [id, summarizeSchedules(list)] as const)));

	/** Switched-on tasks of the server, and the soonest next run. */
	all(serverId: string | null): ScheduleSummary {
		return (serverId && this.summaries[serverId]?.all) || NO_SCHEDULES;
	}
	/** Switched-on tasks of one conversation. */
	of(serverId: string, sessionId: string): ScheduleSummary {
		return this.summaries[serverId]?.bySession.get(sessionId) ?? NO_SCHEDULES;
	}
	/** The tasks listed in one conversation's queue: switched-on ones, soonest first. */
	listOf(serverId: string | null, sessionId: string | null): Schedule[] {
		const list = serverId && sessionId ? this.lists[serverId] : undefined;
		return list ? composerSchedules(list, sessionId!) : [];
	}
	/** A task changed here (paused or deleted): shown at once, before the server's event brings the list back. */
	patch(serverId: string, id: string, next: Schedule | null): void {
		const list = this.lists[serverId];
		if (!list) return;
		this.lists[serverId] = next ? list.map((s) => (s.id === id ? next : s)) : list.filter((s) => s.id !== id);
	}
	/** False once the server turned out to be too old to have scheduled tasks. */
	supported(serverId: string | null): boolean {
		return !serverId || !this.unsupported[serverId];
	}
	/** Record that a server lacks `/schedules` (e.g. learned from an on-demand close check on a non-active server). */
	markUnsupported(serverId: string): void {
		this.read.add(serverId);
		this.stale.delete(serverId);
		this.retryAttempts.delete(serverId);
		this.lists[serverId] = [];
		this.unsupported[serverId] = true;
	}
	/** True once the server's list has been read and is not waiting for a pending refetch. */
	isFresh(serverId: string | null): boolean {
		return !!serverId && this.read.has(serverId) && !this.stale.has(serverId);
	}
	/** Start an immediate fetch only when this server has neither a fresh list nor an active fetch/retry. */
	ensure(serverId: string | null, api: Api | null, opts?: Omit<FollowOpts, "immediate">): (() => void) | void {
		if (!serverId || !api || this.isFresh(serverId) || this.controllers.has(serverId) || this.retryTimers.has(serverId)) return;
		return this.follow(serverId, api, { ...opts, immediate: true });
	}

	private clearTimer(serverId: string): void {
		const t = this.retryTimers.get(serverId);
		if (t !== undefined) {
			clearTimeout(t);
			this.retryTimers.delete(serverId);
		}
	}

	/** Cancel any in-flight read or pending retry for `serverId`, keeping cached tasks. */
	stop(serverId: string): void {
		this.gens.set(serverId, (this.gens.get(serverId) ?? 0) + 1);
		this.clearTimer(serverId);
		const cancel = this.controllers.get(serverId);
		this.controllers.delete(serverId);
		cancel?.();
		this.stale.delete(serverId);
		this.retryAttempts.delete(serverId);
	}

	/** Forget a removed or reconfigured server completely. */
	forget(serverId: string): void {
		this.stop(serverId);
		this.read.delete(serverId);
		this.gens.delete(serverId);
		delete this.lists[serverId];
		delete this.unsupported[serverId];
	}

	/**
	 * Read the server's list. The first read (or `immediate: true`) runs at once; later ones wait for events to pause,
	 * and a newer call for the same server cancels the one waiting or in flight. Transient failures keep what was shown
	 * and retry with bounded backoff while `opts.retry()` returns true.
	 */
	follow(serverId: string | null, api: Api | null, opts?: FollowOpts): (() => void) | void {
		if (!serverId || !api) return;
		this.stop(serverId);
		const gen = (this.gens.get(serverId) ?? 0) + 1;
		this.gens.set(serverId, gen);
		const run = (delay: number) => {
			if (this.gens.get(serverId) !== gen) return;
			if (delay > 0) this.stale.add(serverId);
			const cancel = abortable((signal) => api.schedules(undefined, signal), {
				ok: (r) => {
					if (this.gens.get(serverId) !== gen) return;
					this.controllers.delete(serverId);
					this.read.add(serverId);
					this.stale.delete(serverId);
					this.retryAttempts.delete(serverId);
					this.lists[serverId] = r.schedules;
					delete this.unsupported[serverId];
				},
				fail: (e) => {
					if (this.gens.get(serverId) !== gen) return;
					this.controllers.delete(serverId);
					if (isUnsupportedRoute(e)) {
						this.markUnsupported(serverId);
						return;
					}
					if (!opts?.retry?.()) {
						this.stale.delete(serverId);
						return;
					}
					const attempt = this.retryAttempts.get(serverId) ?? 0;
					const wait = this.retryDelays[attempt];
					if (wait === undefined) {
						this.stale.delete(serverId);
						return;
					}
					this.stale.add(serverId);
					this.retryAttempts.set(serverId, attempt + 1);
					const timer = setTimeout(() => {
						this.retryTimers.delete(serverId);
						if (this.gens.get(serverId) !== gen || !opts.retry?.()) {
							this.stale.delete(serverId);
							return;
						}
						run(0);
					}, wait);
					this.retryTimers.set(serverId, timer);
				},
				delay,
			});
			this.controllers.set(serverId, cancel);
		};
		const delay = opts?.immediate || !this.read.has(serverId) ? 0 : this.pauseMs;
		run(delay);
		return () => {
			if (this.gens.get(serverId) !== gen) return;
			this.stop(serverId);
		};
	}
}
