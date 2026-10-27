import type { Group, PipayaEvent, Session } from "./types";
import type { TerminalInfo } from "./terminal";

/** What the client keeps live about one server: its lists and what each session is doing. */
export interface LinkData {
	sessions: Session[];
	/** Open but tucked into the archive */
	archived: Session[];
	groups: Group[];
	terminals: TerminalInfo[];
	running: Record<string, boolean>;
	awaiting: Record<string, number>;
	unread: Record<string, boolean>;
	failed: Record<string, boolean>;
}

export const emptyLinkData = (): LinkData => ({ sessions: [], archived: [], groups: [], terminals: [], running: {}, awaiting: {}, unread: {}, failed: {} });

/** Events that can change a link's lists (the rest are about a transcript, which a background server does not hold). */
export function applyLinkEvent(d: LinkData, e: PipayaEvent): void {
	const sid = e.sessionId;
	switch (e.type) {
		case "session_created": {
			const s = e.data as Session;
			if (s.closed) break;
			if (s.archived) {
				if (!d.archived.some((x) => x.id === s.id)) d.archived.unshift(s);
			} else if (!d.sessions.some((x) => x.id === s.id)) d.sessions.unshift(s);
			break;
		}
		case "session_updated": {
			const s = e.data as Session;
			d.sessions = d.sessions.filter((x) => x.id !== s.id);
			d.archived = d.archived.filter((x) => x.id !== s.id);
			if (s.closed) {
				d.running[s.id] = false;
				d.awaiting[s.id] = 0;
				delete d.unread[s.id];
				delete d.failed[s.id];
			} else if (s.archived) d.archived.unshift(s);
			else d.sessions.unshift(s);
			break;
		}
		case "session_deleted": {
			const id = (e.data as { id: string }).id;
			d.sessions = d.sessions.filter((x) => x.id !== id);
			d.archived = d.archived.filter((x) => x.id !== id);
			delete d.running[id];
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
				delete d.failed[sid];
			}
			break;
		case "run_finished":
			if (sid) {
				d.running[sid] = false;
				d.awaiting[sid] = 0;
			}
			break;
		case "compaction_started":
			if (sid) d.running[sid] = true;
			break;
		case "compaction_finished":
		case "compaction_failed":
			if (sid) d.running[sid] = false;
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

