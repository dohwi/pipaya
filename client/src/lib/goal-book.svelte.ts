import { abortable } from "./abortable";
import { isUnsupportedRoute, type Api } from "./api";
import type { Goal } from "./types";

/** Events arrive in bursts (accounting flush + status change): refetch once after they pause. */
const PAUSE_MS = 250;
/** Backoff delays (ms) when a transient read fails while the server is still online. */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export interface GoalFollowOpts {
	/** Skip the burst debounce (used on initial connect and full server reconnect/update). */
	immediate?: boolean;
	/** While this returns true, transient (non-404) failures retry with bounded backoff. */
	retry?: () => boolean;
}

/**
 * Per-session goals keyed by server id and session id, mirroring `ScheduleBook`.
 * Tracks every server independently; older servers without `/goals` are remembered and stay quiet.
 */
export class GoalBook {
	private byServer = $state<Record<string, Record<string, Goal>>>({});
	private unsupported = $state<Record<string, true>>({});
	private readonly read = new Set<string>();
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

	of(serverId: string | null | undefined, sessionId: string | null | undefined): Goal | null {
		if (!serverId || !sessionId) return null;
		return this.byServer[serverId]?.[sessionId] ?? null;
	}

	/** Look up a session's goal across loaded servers (session ids are UUIDs; used by `activityOf` and `AgentBadge`). */
	bySessionId(sessionId: string | null | undefined, preferredServerId?: string | null): Goal | null {
		if (!sessionId) return null;
		if (preferredServerId) {
			const hit = this.byServer[preferredServerId]?.[sessionId];
			if (hit) return hit;
		}
		for (const map of Object.values(this.byServer)) {
			const hit = map[sessionId];
			if (hit) return hit;
		}
		return null;
	}

	/** Optimistic update right after PUT/PATCH/DELETE before the SSE refetch lands. */
	patch(serverId: string, sessionId: string, next: Goal | null): void {
		const prev = this.byServer[serverId] ?? {};
		if (next) {
			this.byServer[serverId] = { ...prev, [sessionId]: next };
		} else if (sessionId in prev) {
			const copy = { ...prev };
			delete copy[sessionId];
			this.byServer[serverId] = copy;
		}
	}

	/** False once the server turned out to be older than the goals feature. */
	supported(serverId: string | null): boolean {
		return !serverId || !this.unsupported[serverId];
	}

	/** True once the server's goals have been read and are not waiting for a pending refetch. */
	isFresh(serverId: string | null): boolean {
		return !!serverId && this.read.has(serverId) && !this.stale.has(serverId);
	}

	/** Start an immediate fetch only when this server has neither fresh goals nor an active fetch/retry. */
	ensure(serverId: string | null, api: Api | null, opts?: Omit<GoalFollowOpts, "immediate">): (() => void) | void {
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

	/** Cancel any in-flight read or pending retry for `serverId`, keeping cached goals. */
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
		delete this.byServer[serverId];
		delete this.unsupported[serverId];
	}

	follow(serverId: string | null, api: Api | null, opts?: GoalFollowOpts): (() => void) | void {
		if (!serverId || !api) return;
		this.stop(serverId);
		const gen = (this.gens.get(serverId) ?? 0) + 1;
		this.gens.set(serverId, gen);
		const run = (delay: number) => {
			if (this.gens.get(serverId) !== gen) return;
			if (delay > 0) this.stale.add(serverId);
			const cancel = abortable((signal) => api.goals(undefined, signal), {
				ok: (r) => {
					if (this.gens.get(serverId) !== gen) return;
					this.controllers.delete(serverId);
					this.read.add(serverId);
					this.stale.delete(serverId);
					this.retryAttempts.delete(serverId);
					const map: Record<string, Goal> = {};
					for (const g of r.goals) map[g.sessionId] = g;
					this.byServer[serverId] = map;
					delete this.unsupported[serverId];
				},
				fail: (e) => {
					if (this.gens.get(serverId) !== gen) return;
					this.controllers.delete(serverId);
					if (isUnsupportedRoute(e)) {
						this.read.add(serverId);
						this.stale.delete(serverId);
						this.retryAttempts.delete(serverId);
						this.byServer[serverId] = {};
						this.unsupported[serverId] = true;
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
