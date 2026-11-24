import type { Database } from "bun:sqlite";
import type { ExtensionSessionData } from "./types.ts";

/** Hard ceiling for one page of extension entries returned to clients. */
export const MAX_ENTRY_PAGE = 1000;

export interface ExtensionEntryRow {
	id: number;
	type: string;
	data: unknown;
	createdAt: number;
}

export interface ExtensionEntryWithOwner extends ExtensionEntryRow {
	extension: string;
}

/**
 * SQLite persistence for server extensions: per-session key/value data (`extension_session_data`)
 * and append-only session entries (`extension_entries`).
 */
export class ExtensionStore {
	constructor(private db: Database) {}

	sessionData(extension: string): ExtensionSessionData {
		return {
			get: (sid, key) => {
				const row = this.db.query("SELECT value FROM extension_session_data WHERE session_id = $sid AND extension = $ext AND key = $key")
					.get({ sid, ext: extension, key }) as { value: string } | null;
				return row ? JSON.parse(row.value) : undefined;
			},
			set: (sid, key, value) => {
				const text = JSON.stringify(value ?? null);
				if (text.length > 4000) throw new Error("a session value is at most 4000 characters");
				if (typeof key !== "string" || !key || key.length > 80) throw new Error("key must be 1-80 characters");
				try {
					this.db.query("INSERT INTO extension_session_data (session_id, extension, key, value) VALUES ($sid, $ext, $key, $value) ON CONFLICT (session_id, extension, key) DO UPDATE SET value = excluded.value")
						.run({ sid, ext: extension, key, value: text });
				} catch {
					throw new Error("unknown session");
				}
			},
			delete: (sid, key) => void this.db.query("DELETE FROM extension_session_data WHERE session_id = $sid AND extension = $ext AND key = $key")
				.run({ sid, ext: extension, key }),
			list: (key) => Object.fromEntries(
				(this.db.query("SELECT session_id, value FROM extension_session_data WHERE extension = $ext AND key = $key")
					.all({ ext: extension, key }) as { session_id: string; value: string }[])
					.map((r) => [r.session_id, JSON.parse(r.value)]),
			),
		};
	}

	appendEntry(sessionId: string, extension: string, type: string, data: unknown): ExtensionEntryWithOwner {
		const createdAt = Date.now();
		const payload = data ?? null;
		const res = this.db.query("INSERT INTO extension_entries (session_id, extension, type, data, created_at) VALUES ($sid, $ext, $type, $data, $t)")
			.run({ sid: sessionId, ext: extension, type, data: JSON.stringify(payload), t: createdAt });
		return { id: Number(res.lastInsertRowid), extension, type, data: payload, createdAt };
	}

	entries(sessionId: string, extension: string, type?: string): ExtensionEntryRow[] {
		const rows = (type
			? this.db.query("SELECT id, type, data, created_at FROM extension_entries WHERE session_id = $sid AND extension = $ext AND type = $type ORDER BY id")
				.all({ sid: sessionId, ext: extension, type })
			: this.db.query("SELECT id, type, data, created_at FROM extension_entries WHERE session_id = $sid AND extension = $ext ORDER BY id")
				.all({ sid: sessionId, ext: extension })) as { id: number; type: string; data: string; created_at: number }[];
		return rows.map((r) => ({ id: r.id, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
	}

	allEntries(sessionId: string, extension?: string, type?: string, page: { after?: number; limit?: number } = {}): ExtensionEntryWithOwner[] {
		const limit = Math.min(Math.max(1, Math.floor(page.limit ?? MAX_ENTRY_PAGE)), MAX_ENTRY_PAGE);
		const rows = this.db.query(
			`SELECT id, extension, type, data, created_at FROM extension_entries
			 WHERE session_id = $sid AND ($ext IS NULL OR extension = $ext) AND ($type IS NULL OR type = $type) AND id > $after
			 ORDER BY id LIMIT $limit`,
		).all({ sid: sessionId, ext: extension || null, type: type || null, after: page.after ?? 0, limit }) as
			{ id: number; extension: string; type: string; data: string; created_at: number }[];
		return rows.map((r) => ({ id: r.id, extension: r.extension, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
	}
}
