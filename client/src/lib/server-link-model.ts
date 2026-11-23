import type { Group, PipayaEvent, Session } from "./types";
import { applyQueueEvent, type QueuedItem } from "./queue";
import type { TerminalInfo } from "./terminal";

export type CompactionReason = "manual" | "threshold";

/** What the client keeps live about one server: its lists and what each session is doing. */
export interface LinkData {
	sessions: Session[];
	groups: Group[];
	terminals: TerminalInfo[];
	running: Record<string, boolean>;
	/** Active compaction kind per session, so `compaction_finished` does not clear a running `threshold` compaction's outer run. */
	compacting: Record<string, CompactionReason>;
	awaiting: Record<string, number>;
	unread: Record<string, boolean>;
	failed: Record<string, boolean>;
	/**
	 * What waits in each session's queue and which tool each running session is in, followed from the stream (only the
	 * graph view reads them; the open chat keeps its own). Empty until something is queued or a tool starts after connecting.
	 */
	queued: Record<string, QueuedItem[]>;
	tool: Record<string, { name: string; args: Record<string, unknown> }>;
}

export const emptyLinkData = (): LinkData => ({ sessions: [], groups: [], terminals: [], running: {}, compacting: {}, awaiting: {}, unread: {}, failed: {}, queued: {}, tool: {} });

/**
 * Reconcile `running[sid]` when a compaction ends. A `threshold` compaction always runs inside an agent run (so the
 * session is still working), whereas a `manual` compaction runs standalone and clears `running`. If the client never saw
 * `compaction_started`, fall back to `chatRunning` or ask the caller to verify via `/activity`.
 */
export function settleCompactionRunning(
	running: Record<string, boolean>,
	compacting: Record<string, CompactionReason>,
	sid: string,
	chatRunning?: boolean,
): "keep" | "cleared" | "unknown" {
	const reason = compacting[sid];
	delete compacting[sid];
	if (reason === "threshold") return "keep";
	if (reason === "manual") {
		running[sid] = false;
		return "cleared";
	}
	if (chatRunning) return "keep";
	return "unknown";
}

/** Forget what a session was doing (it closed, was deleted, or its run ended). */
function clearLive(d: LinkData, id: string) {
	delete d.queued[id];
	delete d.tool[id];
}

function queue(d: LinkData, sid: string, type: string, data: unknown) {
	const next = applyQueueEvent(d.queued[sid] ?? [], type, (data ?? {}) as Record<string, unknown>);
	if (next.length) d.queued[sid] = next;
	else delete d.queued[sid];
}

/** The text parts of a message's content (a plain string passes through). */
const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? String(b.text ?? "") : "")).join("") : "");

/**
 * The queue and current tool of a link's sessions (`LinkData.queued` / `tool`). Separate from `applyLinkEvent` because the
 * server in view runs its own handler for the rest, and calls only this.
 */
export function applyLiveEvent(d: LinkData, e: PipayaEvent): void {
	// a closed or deleted session names itself in its data
	if (e.type === "session_deleted" || (e.type === "session_updated" && (e.data as Session).closed)) {
		clearLive(d, (e.data as { id: string }).id);
		return;
	}
	const sid = e.sessionId;
	if (!sid) return;
	switch (e.type) {
		case "run_finished":
			delete d.tool[sid];
			queue(d, sid, e.type, e.data);
			break;
		case "message_queued":
		case "message_dequeued":
			queue(d, sid, e.type, e.data);
			break;
		case "message_end": {
			const m = (e.data as { message?: { role?: string; content?: unknown } } | null)?.message;
			if (m?.role === "user" && d.queued[sid]) queue(d, sid, "delivered", { text: textOf(m.content) });
			break;
		}
		case "tool_execution_start": {
			const t = e.data as { toolName?: unknown; args?: unknown };
			if (typeof t.toolName === "string") d.tool[sid] = { name: t.toolName, args: t.args && typeof t.args === "object" ? (t.args as Record<string, unknown>) : {} };
			break;
		}
		case "tool_execution_end":
			delete d.tool[sid];
			break;
	}
}

/** Events that can change a link's lists (the rest are about a transcript, which a background server does not hold). */
export function applyLinkEvent(d: LinkData, e: PipayaEvent, onUnknownCompaction?: (sid: string) => void): void {
	const sid = e.sessionId;
	switch (e.type) {
		case "session_created": {
			const s = e.data as Session;
			if (s.closed) break;
			if (!d.sessions.some((x) => x.id === s.id)) d.sessions.unshift(s);
			break;
		}
		case "session_updated": {
			const s = e.data as Session;
			d.sessions = d.sessions.filter((x) => x.id !== s.id);
			if (s.closed) {
				d.running[s.id] = false;
				delete d.compacting[s.id];
				d.awaiting[s.id] = 0;
				delete d.unread[s.id];
				delete d.failed[s.id];
			} else d.sessions.unshift(s);
			break;
		}
		case "session_deleted": {
			const id = (e.data as { id: string }).id;
			d.sessions = d.sessions.filter((x) => x.id !== id);
			delete d.running[id];
			delete d.compacting[id];
			delete d.awaiting[id];
			delete d.unread[id];
			delete d.failed[id];
			break;
		}
		case "group_created":
		case "group_updated": {
			const g = e.data as Group;
			const i = d.groups.findIndex((x) => x.id === g.id);
			if (i >= 0) d.groups[i] = g;
			else d.groups.push(g);
			break;
		}
		case "group_deleted":
			d.groups = d.groups.filter((x) => x.id !== (e.data as { id: string }).id);
			break;
		case "terminal_created":
		case "terminal_updated": {
			const x = e.data as TerminalInfo;
			const i = d.terminals.findIndex((y) => y.id === x.id);
			if (i >= 0) d.terminals[i] = x;
			else d.terminals.push(x);
			break;
		}
		case "terminal_closed":
			d.terminals = d.terminals.filter((x) => x.id !== (e.data as { id: string }).id);
			break;
		case "run_started":
			if (sid) {
				d.running[sid] = true;
				delete d.compacting[sid];
				delete d.failed[sid];
			}
			break;
		case "run_finished":
			if (sid) {
				d.running[sid] = false;
				delete d.compacting[sid];
				d.awaiting[sid] = 0;
			}
			break;
		case "compaction_started":
			if (sid) {
				const reason = (e.data as { reason?: unknown } | null)?.reason;
				d.compacting[sid] = reason === "manual" ? "manual" : "threshold";
				d.running[sid] = true;
			}
			break;
		case "compaction_finished":
		case "compaction_failed":
			if (sid && settleCompactionRunning(d.running, d.compacting, sid) === "unknown") onUnknownCompaction?.(sid);
			break;
		case "question_requested":
			if (sid) d.awaiting[sid] = (d.awaiting[sid] ?? 0) + 1;
			break;
		case "question_resolved":
			if (sid) d.awaiting[sid] = Math.max(0, (d.awaiting[sid] ?? 0) - 1);
			break;
		case "session_unread": {
			const u = e.data as { sessionId: string; kind: "done" | "failed" | null };
			delete d.unread[u.sessionId];
			delete d.failed[u.sessionId];
			if (u.kind === "done") d.unread[u.sessionId] = true;
			else if (u.kind === "failed") d.failed[u.sessionId] = true;
			break;
		}
	}
}

