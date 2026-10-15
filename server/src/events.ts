import type { Database, Statement } from "bun:sqlite";

/**
 * Envelope for everything the server emits.
 *
 * `id` is a global, monotonically increasing cursor for persisted events.
 * Ephemeral events (streaming deltas) have `id === 0`; they are delivered live
 * only and are never replayed.
 */
export interface HarnessEvent {
	id: number;
	sessionId: string | null;
	type: string;
	ts: number;
	data: unknown;
}

type Listener = (event: HarnessEvent) => void;

interface EventRow {
	id: number;
	session_id: string | null;
	type: string;
	data: string;
	ts: number;
}

const toEvent = (r: EventRow): HarnessEvent => ({
	id: r.id,
	sessionId: r.session_id,
	type: r.type,
	ts: r.ts,
	data: JSON.parse(r.data),
});

export class EventBus {
	private listeners = new Set<{ fn: Listener; sessionId?: string }>();
	private insert: Statement;
	private selectAll: Statement;
	private selectSession: Statement;
	private selectLatest: Statement;

	constructor(private db: Database) {
		this.insert = db.query("INSERT INTO events (session_id, type, data, ts) VALUES ($sessionId, $type, $data, $ts)");
		this.selectAll = db.query("SELECT * FROM events WHERE id > $after ORDER BY id LIMIT $limit");
		this.selectSession = db.query(
			"SELECT * FROM events WHERE session_id = $sessionId AND id > $after ORDER BY id LIMIT $limit",
		);
		this.selectLatest = db.query("SELECT COALESCE(MAX(id), 0) AS id FROM events");
	}

	publish(sessionId: string | null, type: string, data: unknown, opts: { ephemeral?: boolean } = {}): HarnessEvent {
		const ts = Date.now();
		let id = 0;
		if (!opts.ephemeral) {
			const res = this.insert.run({ sessionId, type, data: JSON.stringify(data ?? null), ts });
			id = Number(res.lastInsertRowid);
		}
		const event: HarnessEvent = { id, sessionId, type, ts, data };
		for (const l of this.listeners) {
			if (l.sessionId && l.sessionId !== sessionId) continue;
			try {
				l.fn(event);
			} catch {
				// A broken subscriber must never break the publisher.
			}
		}
		return event;
	}

	/** Subscribe to live events. Pass `sessionId` to receive only that session's events. */
	subscribe(fn: Listener, sessionId?: string): () => void {
		const entry = { fn, sessionId };
		this.listeners.add(entry);
		return () => this.listeners.delete(entry);
	}

	history(opts: { sessionId?: string; after: number; limit: number }): HarnessEvent[] {
		const rows = (
			opts.sessionId
				? this.selectSession.all({ sessionId: opts.sessionId, after: opts.after, limit: opts.limit })
				: this.selectAll.all({ after: opts.after, limit: opts.limit })
		) as EventRow[];
		return rows.map(toEvent);
	}

	/** Drop persisted events older than `maxAgeMs`; messages are stored separately and unaffected. */
	prune(maxAgeMs: number): number {
		return this.db.query("DELETE FROM events WHERE ts < $cutoff").run({ cutoff: Date.now() - maxAgeMs }).changes;
	}

	latestId(): number {
		return (this.selectLatest.get() as { id: number }).id;
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}
}
