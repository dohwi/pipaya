import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: (string | ((db: Database) => void))[] = [
	// v1
	`
	CREATE TABLE sessions (
		id            TEXT PRIMARY KEY,
		title         TEXT NOT NULL,
		cwd           TEXT NOT NULL,
		provider      TEXT NOT NULL,
		model         TEXT NOT NULL,
		thinking_level TEXT NOT NULL,
		system_prompt TEXT NOT NULL,
		tools         TEXT NOT NULL,
		approval      TEXT NOT NULL,
		parent_id     TEXT,
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);
	CREATE INDEX sessions_updated ON sessions(updated_at DESC);

	CREATE TABLE messages (
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		seq        INTEGER NOT NULL,
		role       TEXT NOT NULL,
		data       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (session_id, seq)
	);

	CREATE TABLE events (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT,
		type       TEXT NOT NULL,
		data       TEXT NOT NULL,
		ts         INTEGER NOT NULL
	);
	CREATE INDEX events_session ON events(session_id, id);

	CREATE TABLE credentials (
		provider_id TEXT PRIMARY KEY,
		data        TEXT NOT NULL
	);
	`,
	// v2: user-editable model connections and defaults (secrets remain in credentials).
	`CREATE TABLE custom_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
	 CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);`,
	// v3: sessions can be closed (hidden from the active list) and resumed later.
	`ALTER TABLE sessions ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
	 CREATE INDEX sessions_closed ON sessions(closed, updated_at DESC);`,
	// v4: reasoning can no longer be disabled; preserve all other session settings.
	`UPDATE sessions SET thinking_level = 'medium' WHERE thinking_level = 'off';`,
	// v5: session groups: a named split-window layout whose panes hold sessions (a session is in at most one group).
	`CREATE TABLE IF NOT EXISTS groups (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		layout     TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS groups_created ON groups(created_at);`,
	// v6: immutable instructions applied at the first model run.
	`CREATE TABLE IF NOT EXISTS session_contexts (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		data TEXT NOT NULL
	);`,
	// v7: durable notification registrations; focus leases are deliberately not persisted.
	`CREATE TABLE IF NOT EXISTS notification_devices (id TEXT PRIMARY KEY, platform TEXT NOT NULL, enabled INTEGER NOT NULL, token TEXT, provider TEXT NOT NULL DEFAULT 'fcm');
	 CREATE TABLE IF NOT EXISTS notification_rules (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner, id));
	 CREATE TABLE IF NOT EXISTS notification_dedupe (key TEXT PRIMARY KEY, id TEXT NOT NULL, at INTEGER NOT NULL);`,
	// v8: client settings that belong to this server (shared by every client connected to it), last write wins per key.
	`CREATE TABLE IF NOT EXISTS client_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
	// v9: mobile pushes waiting for "was the PC notification read?"; minutes-long waits must survive a restart.
	`CREATE TABLE IF NOT EXISTS notification_escalations (id TEXT PRIMARY KEY, due_at INTEGER NOT NULL, payload TEXT NOT NULL);`,
	// v10: the language each device reads, so a push that never passes through the app is already in that language.
	// A function rather than SQL: SQLite has no "ADD COLUMN IF NOT EXISTS", and a database stepped back and reopened runs this again.
	(db) => { if (!(db.query("PRAGMA table_info(notification_devices)").all() as { name: string }[]).some((c) => c.name === "lang")) db.exec("ALTER TABLE notification_devices ADD COLUMN lang TEXT"); },
	// v11: a name each device gives itself and when it was last heard from, so the device list can tell one phone from another.
	(db) => {
		const have = (db.query("PRAGMA table_info(notification_devices)").all() as { name: string }[]).map((c) => c.name);
		if (!have.includes("name")) db.exec("ALTER TABLE notification_devices ADD COLUMN name TEXT");
		if (!have.includes("last_seen")) db.exec("ALTER TABLE notification_devices ADD COLUMN last_seen INTEGER");
	},
	// v12: what the device is running ("macOS 15.1 · arm64") and which client ("Desktop app 0.1.42"), to tell two similar devices apart.
	(db) => {
		const have = (db.query("PRAGMA table_info(notification_devices)").all() as { name: string }[]).map((c) => c.name);
		if (!have.includes("os")) db.exec("ALTER TABLE notification_devices ADD COLUMN os TEXT");
		if (!have.includes("app")) db.exec("ALTER TABLE notification_devices ADD COLUMN app TEXT");
	},
	// v13: one access token per paired device. Only the SHA-256 of a token is kept.
	`CREATE TABLE IF NOT EXISTS device_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER);`,
	// v14: context compaction. Messages with seq <= upto_seq are replaced, for the model only, by `summary`; the transcript itself is untouched.
	`CREATE TABLE IF NOT EXISTS session_compactions (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		upto_seq      INTEGER NOT NULL,
		summary       TEXT NOT NULL,
		tokens_before INTEGER NOT NULL,
		usage         TEXT,
		created_at    INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS session_compactions_session ON session_compactions(session_id, id);`,
	// v15: skill on/off overrides that apply to a single session only.
	`CREATE TABLE IF NOT EXISTS session_skills (
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		name       TEXT NOT NULL,
		enabled    INTEGER NOT NULL,
		PRIMARY KEY (session_id, name)
	);`,
	// v16: entries that server extensions keep on a session (not part of the transcript, never sent to the model).
	`CREATE TABLE IF NOT EXISTS extension_entries (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		extension  TEXT NOT NULL,
		type       TEXT NOT NULL,
		data       TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS extension_entries_session ON extension_entries(session_id, extension, id);`,
	// v17: the apps no longer offer "read-only": `ask` now means "confirm only what reaches outside the project". A session or
	// saved default stuck on read-only would have no way back out of it, so both fold into `ask`.
	`UPDATE sessions SET approval = 'ask' WHERE approval = 'readonly';
	 DELETE FROM settings WHERE key = 'default_approval' AND data = '"readonly"';`,
];

export function openDb(path: string): Database {
	const isNew = path !== ":memory:" && !existsSync(path);
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new Database(path, { create: true, strict: true });
	if (isNew) chmodSync(path, 0o600);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	migrate(db);
	return db;
}

function migrate(db: Database): void {
	const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
	for (let v = current; v < MIGRATIONS.length; v++) {
		db.transaction(() => {
			const step = MIGRATIONS[v] as string | ((db: Database) => void);
			if (typeof step === "string") db.exec(step); else step(db);
			db.exec(`PRAGMA user_version = ${v + 1}`);
		})();
	}
}
