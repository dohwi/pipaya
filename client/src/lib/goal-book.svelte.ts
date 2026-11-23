import { abortable } from "./abortable";
import { isUnsupportedRoute, type Api } from "./api";
import type { Goal } from "./types";

/** Events arrive in bursts (accounting flush + status change): refetch once after they pause. */
const PAUSE_MS = 250;

/**
 * Per-session goals keyed by server id and session id, mirroring `ScheduleBook`.
 * Call `follow()` from an `$effect`; it returns the cleanup. Older servers without `/goals` are remembered and stay quiet.
 */
export class GoalBook {
	private byServer = $state<Record<string, Record<string, Goal>>>({});
	private unsupported = $state<Record<string, true>>({});
	private readonly read = new Set<string>();

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

	follow(serverId: string | null, api: Api | null): (() => void) | void {
		if (!serverId || !api) return;
		return abortable((signal) => api.goals(undefined, signal), {
			ok: (r) => {
				this.read.add(serverId);
				const map: Record<string, Goal> = {};
				for (const g of r.goals) map[g.sessionId] = g;
				this.byServer[serverId] = map;
				delete this.unsupported[serverId];
			},
			fail: (e) => {
				if (!isUnsupportedRoute(e)) return;
				this.read.add(serverId);
				this.byServer[serverId] = {};
				this.unsupported[serverId] = true;
			},
			delay: this.read.has(serverId) ? PAUSE_MS : 0,
		});
	}
}
