/**
 * What the graph view's detail dialog shows for a server, provider, model or subagent card. Pure: it reads the graph and
 * the server's delegate calls; `GraphDetail.svelte` only draws it.
 */
import type { Card, CardKind, DelegateRun, Graph } from "./graph";

/** The cards of `kind` under `id`, in the order the graph shows them (its columns are sorted by urgency, then size). */
export function under(g: Graph, id: string, kind: CardKind): Card[] {
	const out: Card[] = [];
	const walk = (x: string) => {
		for (const k of g.cards.get(x)?.children ?? []) {
			const c = g.cards.get(k);
			if (!c) continue;
			if (c.kind === kind) out.push(c);
			walk(k);
		}
	};
	walk(id);
	return out;
}

/** How one call of a role ended: still running, an error, cut off before a result (a restart), or done. */
export type CallState = "running" | "failed" | "cut" | "done";
export const callState = (r: DelegateRun): CallState => (r.running ? "running" : r.error ? "failed" : r.doneAt === null ? "cut" : "done");

export interface RoleStats {
	calls: number;
	running: number;
	failed: number;
	/** Tokens and turns of the calls that report them. */
	tokens: number;
	turns: number;
	/** Mean time of the finished calls; null when none finished. */
	avgMs: number | null;
	/** The chats that called it, the most recent caller first. */
	callers: { sessionId: string; n: number; last: number }[];
	/** Its calls, newest first, at most `limit`. */
	recent: DelegateRun[];
}

/** One role's calls on one server, counted the way its card counts them: only calls made from open chats. */
export function roleStats(runs: DelegateRun[], role: string, open: (sessionId: string) => boolean, limit = 20): RoleStats {
	const mine = runs.filter((r) => r.role === role && open(r.sessionId));
	const callers = new Map<string, { sessionId: string; n: number; last: number }>();
	let tokens = 0, turns = 0, ms = 0, finished = 0;
	for (const r of mine) {
		const c = callers.get(r.sessionId) ?? { sessionId: r.sessionId, n: 0, last: 0 };
		c.n++;
		c.last = Math.max(c.last, r.at);
		callers.set(r.sessionId, c);
		tokens += r.tokens ?? 0;
		turns += r.turns ?? 0;
		if (r.doneAt !== null && !r.running) { ms += Math.max(0, r.doneAt - r.at); finished++; }
	}
	return {
		calls: mine.length,
		running: mine.filter((r) => r.running).length,
		failed: mine.filter((r) => callState(r) === "failed").length,
		tokens,
		turns,
		avgMs: finished ? ms / finished : null,
		callers: [...callers.values()].sort((a, b) => b.last - a.last),
		recent: [...mine].sort((a, b) => b.at - a.at).slice(0, limit),
	};
}
