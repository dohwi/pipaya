import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { groupHandle, nextMemberName } from "./member-names.ts";

/** SQLite has no `ADD COLUMN IF NOT EXISTS`, and a database stepped back and reopened runs a migration again: these make a step safe to repeat. */
const columns = (db: Database, table: string): string[] => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const addColumn = (db: Database, table: string, name: string, definition: string): void => {
	if (!columns(db, table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
};
const dropColumn = (db: Database, table: string, name: string): void => {
	if (columns(db, table).includes(name)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
};

export const MIGRATIONS: (string | ((db: Database) => void))[] = [
	// v1
	`
	CREATE TABLE IF NOT EXISTS sessions (
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
	CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);

	CREATE TABLE IF NOT EXISTS messages (
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		seq        INTEGER NOT NULL,
		role       TEXT NOT NULL,
		data       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (session_id, seq)
	);

	CREATE TABLE IF NOT EXISTS events (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT,
		type       TEXT NOT NULL,
		data       TEXT NOT NULL,
		ts         INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);

	CREATE TABLE IF NOT EXISTS credentials (
		provider_id TEXT PRIMARY KEY,
		data        TEXT NOT NULL
	);
	`,
	// v2: user-editable model connections and defaults (secrets remain in credentials).
	`CREATE TABLE IF NOT EXISTS custom_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
	 CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);`,
	// v3: sessions can be closed (hidden from the active list) and resumed later.
	(db) => {
		addColumn(db, "sessions", "closed", "INTEGER NOT NULL DEFAULT 0");
		db.exec("CREATE INDEX IF NOT EXISTS sessions_closed ON sessions(closed, updated_at DESC)");
	},
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
	// v6: base prompt, tools and cwd captured at the first model run (AGENTS.md is re-read live).
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
	(db) => addColumn(db, "notification_devices", "lang", "TEXT"),
	// v11: a name each device gives itself and when it was last heard from, so the device list can tell one phone from another.
	(db) => {
		addColumn(db, "notification_devices", "name", "TEXT");
		addColumn(db, "notification_devices", "last_seen", "INTEGER");
	},
	// v12: what the device is running ("macOS 15.1 · arm64") and which client ("Desktop app 0.1.42"), to tell two similar devices apart.
	(db) => {
		addColumn(db, "notification_devices", "os", "TEXT");
		addColumn(db, "notification_devices", "app", "TEXT");
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
	(db) => {
		// The column is dropped further down: a database stepped back past that and reopened has none left to fold.
		if (columns(db, "sessions").includes("approval")) db.exec("UPDATE sessions SET approval = 'ask' WHERE approval = 'readonly'");
		db.exec(`DELETE FROM settings WHERE key = 'default_approval' AND data = '"readonly"'`);
	},
	// v18: a name per session in a group (JSON { sessionId: name }). Unused since v22; dropped in v23.
	(db) => addColumn(db, "groups", "names", "TEXT NOT NULL DEFAULT '{}'"),
	// v19: a name for each session (since moved out of core, see v22): the column is added; older databases already had names given here.
	(db) => addColumn(db, "sessions", "name", "TEXT NOT NULL DEFAULT ''"),
	// v20: what a session's agent works on (written by the system model). Any client or extension may read it.
	(db) => addColumn(db, "sessions", "purpose", "TEXT NOT NULL DEFAULT ''"),
	// v21: a group's tag (its name with dashes, any case) must differ from every other group's and from the names extensions
	// gave sessions at the time. Older duplicates keep the first (by creation) and get " 2", " 3", ... appended.
	(db) => {
		const handle = (n: string) => n.trim().replace(/\s+/g, "-").toLowerCase();
		const taken = new Set((db.query("SELECT name FROM sessions WHERE closed = 0 AND name != ''").all() as { name: string }[]).map((r) => r.name.toLowerCase()));
		const set = db.query("UPDATE groups SET name = $name WHERE id = $id");
		for (const g of db.query("SELECT id, name FROM groups ORDER BY created_at, id").all() as { id: string; name: string }[]) {
			let name = g.name;
			for (let n = 2; taken.has(handle(name)); n++) name = `${g.name} ${n}`;
			taken.add(handle(name));
			if (name !== g.name) set.run({ id: g.id, name });
		}
	},
	// The approval option is gone: every tool runs without asking, so neither the per-session policy nor the saved default is kept.
	(db) => {
		dropColumn(db, "sessions", "approval");
		db.exec("DELETE FROM settings WHERE key = 'default_approval'");
	},
	// Images uploaded as model icons (a model's `icon` is "img:<id>").
	`CREATE TABLE IF NOT EXISTS model_icons (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);`,
	// v22: names are no longer a core concept. A generic per-session store for extensions takes over and the column goes.
	`CREATE TABLE IF NOT EXISTS extension_session_data (
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		extension  TEXT NOT NULL,
		key        TEXT NOT NULL,
		value      TEXT NOT NULL,
		PRIMARY KEY (session_id, extension, key)
	);`,
	(db) => dropColumn(db, "sessions", "name"),
	// v23: nothing reads groups.names any more. Drop the column.
	(db) => dropColumn(db, "groups", "names"),
	// v24: what finished while nobody was looking is kept by the server, so every device shows (and clears) the same marks.
	`CREATE TABLE IF NOT EXISTS session_unread (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		kind       TEXT NOT NULL,
		at         INTEGER NOT NULL
	);`,
	// v25: a session can be archived: still open (not closed), but tucked away in the apps' archive instead of the active list.
	(db) => addColumn(db, "sessions", "archived", "INTEGER NOT NULL DEFAULT 0"),
	// v26: session @names are part of the core again (peer_send / peer_read address sessions by them). Active sessions are numbered in creation order.
	(db) => {
		addColumn(db, "sessions", "name", "TEXT NOT NULL DEFAULT ''");
		const taken = new Set<string>((db.query("SELECT name FROM groups").all() as { name: string }[]).map((g) => groupHandle(g.name).toLowerCase()));
		const set = db.query("UPDATE sessions SET name = $name WHERE id = $id");
		for (const s of db.query("SELECT id FROM sessions WHERE name = '' AND closed = 0 ORDER BY created_at, id").all() as { id: string }[]) {
			const name = nextMemberName(taken);
			taken.add(name.toLowerCase());
			set.run({ id: s.id, name });
		}
	},
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
