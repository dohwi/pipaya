/**
 * The `delegate` calls of every saved server, for the graph view: read with `GET /delegates` while the view is open and
 * read again a moment after a server says something changed (a tool started or ended, a run ended). A server without the
 * route (older) or that fails keeps `null`: the graph then shows its chats without subagents.
 */
import type { Api } from "./api";
import type { DelegateRun } from "./graph";
import type { LinkData } from "./server-link-model";

/** Fast enough to see a subagent start and end; the events below pull it in sooner. */
const POLL_MS = 5000;
/** Events that can add or finish a delegate call come in bursts: one read for the burst. */
const SETTLE_MS = 400;

export class GraphRuns {
	runs = $state<Record<string, DelegateRun[] | null>>({});
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private busy = new Set<string>();
	private again = new Set<string>();
	private apis = new Map<string, Api>();
	private poll: ReturnType<typeof setInterval> | undefined;

	/**
	 * Start following `servers` (id → API and its live lists); returns the stop function. The queue and current tool of a
	 * running session are only followed from the stream, so one read of each running session's status fills in what
	 * happened before this device connected.
	 */
	follow(servers: Map<string, { api: Api; data: LinkData }>): () => void {
		this.apis = new Map([...servers].map(([id, v]) => [id, v.api]));
		for (const { api, data } of servers.values()) void seedLive(api, data);
		for (const id of Object.keys(this.runs)) if (!servers.has(id)) delete this.runs[id];
		for (const id of this.apis.keys()) void this.read(id);
		clearInterval(this.poll);
		this.poll = setInterval(() => { for (const id of this.apis.keys()) void this.read(id); }, POLL_MS);
		return () => {
			clearInterval(this.poll);
			this.poll = undefined;
			for (const t of this.timers.values()) clearTimeout(t);
			this.timers.clear();
			this.apis = new Map();
		};
	}

	/** A server's event: re-read soon when it may have touched a delegate call. */
	onEvent(server: string, type: string, data: unknown): void {
		if (!this.apis.has(server)) return;
		const tool = (data as { toolName?: unknown } | null)?.toolName;
		const touches = ((type === "tool_execution_start" || type === "tool_execution_end") && tool === "delegate") || type === "run_finished" || type === "session_updated" || type === "session_deleted";
		if (!touches) return;
		clearTimeout(this.timers.get(server));
		this.timers.set(server, setTimeout(() => { this.timers.delete(server); void this.read(server); }, SETTLE_MS));
	}

	private async read(server: string): Promise<void> {
		const api = this.apis.get(server);
		if (!api) return;
		if (this.busy.has(server)) { this.again.add(server); return; } // one request at a time per server; the last ask wins
		this.busy.add(server);
		try {
			const runs = await api.delegates();
			if (this.apis.get(server) === api) this.runs[server] = runs;
		} catch {
			if (this.apis.get(server) === api && !(server in this.runs)) this.runs[server] = null;
		} finally {
			this.busy.delete(server);
			if (this.again.delete(server)) void this.read(server);
		}
	}
}

/** Fill a link's queue and current tool from the status of its running sessions (only where the stream has not yet). */
async function seedLive(api: Api, d: LinkData): Promise<void> {
	const ids = Object.keys(d.running).filter((id) => d.running[id]);
	await Promise.all(ids.map(async (id) => {
		try {
			const st = (await api.getSession(id)).status;
			if (!d.queued[id] && st.queuedMessages?.length) d.queued[id] = st.queuedMessages.map((q) => ({ mode: q.mode, text: q.text, ...(q.deferred ? { deferred: true } : {}) }));
		} catch {
			/* a session that just closed: nothing to show */
		}
	}));
}

export const graphRuns = new GraphRuns();
