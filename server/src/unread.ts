import type { Database } from "bun:sqlite";
import type { EventBus, PipayaEvent } from "./events.ts";

export type UnreadKind = "done" | "failed";

/**
 * Which sessions finished (or failed) while no device was looking at them. The server keeps the marks, so reading a
 * session on one device clears it on all of them, and a device that was off still learns what finished meanwhile.
 */
export class UnreadTracker {
	private unsubscribe: () => void;
	/** `watching(id)`: a focused device is showing this session right now. */
	constructor(private db: Database, private bus: EventBus, private watching: (sessionId: string) => boolean) {
		this.unsubscribe = bus.subscribe((e) => this.onEvent(e));
	}

	list(): { sessionId: string; kind: UnreadKind }[] {
		return (this.db.query("SELECT session_id AS sessionId, kind FROM session_unread").all() as { sessionId: string; kind: UnreadKind }[]);
	}

	/** The sessions were looked at: their marks go, and every client is told. */
	read(sessionIds: string[]): void {
		for (const id of sessionIds) {
			if (this.db.query("DELETE FROM session_unread WHERE session_id = ?").run(id).changes) this.bus.publish(null, "session_unread", { sessionId: id, kind: null }, { ephemeral: true });
		}
	}

	private set(sessionId: string, kind: UnreadKind): void {
		// The session may be gone already (the foreign key would refuse the row).
		const exists = this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
		if (!exists) return;
		this.db.query("INSERT INTO session_unread (session_id, kind, at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind, at = excluded.at").run(sessionId, kind, Date.now());
		this.bus.publish(null, "session_unread", { sessionId, kind }, { ephemeral: true });
	}

	private onEvent(e: PipayaEvent): void {
		const id = e.sessionId;
		if (!id) return;
		if (e.type === "run_started") this.read([id]);
		else if (e.type === "run_finished") {
			const status = (e.data as { status?: string }).status;
			if (status === "aborted") return; // a stopped run is the user's own doing
			if (!this.watching(id)) this.set(id, status === "error" ? "failed" : "done");
		} else if (e.type === "session_updated" && (e.data as { closed?: boolean }).closed) {
			this.db.query("DELETE FROM session_unread WHERE session_id = ?").run(id);
		}
	}

	dispose(): void { this.unsubscribe(); }
}
