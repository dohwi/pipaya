import { describe, expect, test } from "bun:test";
import { MIGRATIONS, openDb } from "../src/db.ts";

// Column order is not part of the schema: a step that drops and re-adds a column (v23 / v26 for `name`) moves it to the end.
const schema = (db: ReturnType<typeof openDb>) => JSON.stringify((db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; sql: string }[])
	.map((o) => (o.type === "table" ? { type: o.type, name: o.name, columns: (db.query(`PRAGMA table_info(${o.name})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]).map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk })).sort((a, b) => a.name.localeCompare(b.name)) } : o)));

describe("migrations", () => {
	test("every step can run again on a finished database without failing or changing the schema", () => {
		const db = openDb(":memory:");
		const before = schema(db);
		for (let i = 0; i < MIGRATIONS.length; i++) {
			const step = MIGRATIONS[i]!;
			expect(() => db.transaction(() => (typeof step === "string" ? db.exec(step) : step(db)))(), `step v${i + 1}`).not.toThrow();
		}
		expect(schema(db)).toBe(before);
	});

	test("a database is stepped to the latest version exactly once", () => {
		const db = openDb(":memory:");
		expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
	});

	test("duplicate active names (case-insensitive) are split: the oldest keeps the name, closed ones are left alone", () => {
		const db = openDb(":memory:");
		const add = db.query("INSERT INTO sessions (id, title, name, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at) VALUES ($id, 't', $name, '/', 'p', 'm', 'off', '', '[]', $closed, $at, $at)");
		add.run({ id: "a", name: "A1", closed: 0, at: 1 });
		add.run({ id: "b", name: "a1", closed: 0, at: 2 });
		add.run({ id: "c", name: "B1", closed: 0, at: 3 });
		add.run({ id: "d", name: "b1", closed: 0, at: 4 });
		add.run({ id: "e", name: "A1", closed: 1, at: 5 }); // closed: untouched by v31
		add.run({ id: "f", name: "C1", closed: 0, at: 6 });
		for (const step of MIGRATIONS.slice(32, 34)) { // v30 (no-op) and v31 (dedupe active)
			if (typeof step !== "string") step(db);
		}
		const names = Object.fromEntries((db.query("SELECT id, name FROM sessions").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
		expect(names.a).toBe("A1");
		expect(names.c).toBe("B1"); // keeps its name: only the duplicates (b, d) move
		expect(names.e).toBe("A1");
		expect(names.f).toBe("C1");
		expect(names.b!.toLowerCase()).not.toBe("a1");
		expect(names.d!.toLowerCase()).not.toBe("b1");
		const active = ["a", "b", "c", "d", "f"].map((id) => names[id]!.toLowerCase());
		expect(new Set(active).size).toBe(5); // no two active sessions share a name any more
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 6 }); // nothing deleted
	});

	test("no two sessions share a name, closed ones included: an open one keeps it, else the oldest closed one", () => {
		const db = openDb(":memory:");
		const add = db.query("INSERT INTO sessions (id, title, name, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at) VALUES ($id, 't', $name, '/', 'p', 'm', 'off', '', '[]', $closed, $at, $at)");
		add.run({ id: "old", name: "A1", closed: 1, at: 1 }); // closed, then an open session took its name
		add.run({ id: "open", name: "A1", closed: 0, at: 2 });
		add.run({ id: "c1", name: "B1", closed: 1, at: 3 }); // two closed holders: the older one keeps it
		add.run({ id: "c2", name: "b1", closed: 1, at: 4 });
		add.run({ id: "solo", name: "C1", closed: 1, at: 5 }); // nobody else has it: untouched
		add.run({ id: "none", name: "", closed: 1, at: 6 }); // never had one: stays without
		const step = MIGRATIONS[38]!;
		if (typeof step !== "string") step(db);
		const names = () => Object.fromEntries((db.query("SELECT id, name FROM sessions").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
		const after = names();
		expect(after.open).toBe("A1");
		expect(after.c1).toBe("B1");
		expect(after.solo).toBe("C1");
		expect(after.none).toBe("");
		expect(["a1", "b1", "c1"]).not.toContain(after.old!.toLowerCase());
		expect(["a1", "b1", "c1", after.old!.toLowerCase()]).not.toContain(after.c2!.toLowerCase());
		// running it again changes nothing
		if (typeof step !== "string") step(db);
		expect(names()).toEqual(after);
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 6 });
	});

	test("codename migration converts legacy Korean names into lineage codenames, prioritizes open sessions, and keeps custom handles", () => {
		const db = openDb(":memory:");
		const add = db.query("INSERT INTO sessions (id, title, name, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, closed, created_at, updated_at) VALUES ($id, 't', $name, '/', 'p', 'm', 'off', '', '[]', $parent, $closed, $at, $at)");
		add.run({ id: "closed_old", name: "철수", parent: null, closed: 1, at: 1 });
		add.run({ id: "open_root", name: "미나", parent: null, closed: 0, at: 2 });
		add.run({ id: "open_child", name: "지혁", parent: "open_root", closed: 0, at: 3 });
		add.run({ id: "closed_mid", name: "민준2", parent: "open_root", closed: 1, at: 4 });
		add.run({ id: "open_grandchild", name: "서아", parent: "closed_mid", closed: 0, at: 5 });
		add.run({ id: "open_other", name: "가온", parent: null, closed: 0, at: 6 });
		add.run({ id: "custom", name: "ops", parent: null, closed: 0, at: 7 });
		add.run({ id: "empty_closed", name: "", parent: null, closed: 1, at: 8 });
		// Reserve B1 via a group so open_other skips B and gets C1
		db.query("INSERT INTO groups (id, name, layout, created_at, updated_at) VALUES ('g1', 'B1', '{}', 1, 1)").run();

		const step = MIGRATIONS[MIGRATIONS.length - 1]!;
		expect(typeof step).toBe("function");
		if (typeof step !== "string") step(db);
		const names = () => Object.fromEntries((db.query("SELECT id, name FROM sessions").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
		const after = names();
		expect(after.open_root).toBe("A1");
		expect(after.open_child).toBe("A2");
		expect(after.open_grandchild).toBe("A3"); // walked through closed_mid to open_root
		expect(after.open_other).toBe("C1"); // B reserved by group B1
		expect(after.custom).toBe("ops");
		expect(after.empty_closed).toBe("");
		expect(after.closed_mid).toBe("A4"); // inherits open_root's prefix
		expect(after.closed_old).toBe("D1"); // closed root assigned after open roots
		// idempotent on re-run
		if (typeof step !== "string") step(db);
		expect(names()).toEqual(after);
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 8 });
	});

	test("active_runs: the table is created and survives re-running the migration", () => {
		const db = openDb(":memory:");
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s', 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		db.query("INSERT INTO active_runs (session_id, origin, started_at, pending_prompt) VALUES ('s', 'user', 10, NULL)").run();
		const step = MIGRATIONS[39]!;
		expect(typeof step).toBe("string");
		db.exec(step as string);
		expect(db.query("SELECT session_id, origin, started_at FROM active_runs").all()).toEqual([{ session_id: "s", origin: "user", started_at: 10 }]);
	});

	test("scheduled tasks: the table is created by v32, which can run again and keeps the rows", () => {
		const db = openDb(":memory:");
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s', 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		db.query("INSERT INTO scheduled_tasks (id, session_id, prompt, kind, every_ms, next_run_at, created_at, updated_at) VALUES ('t', 's', 'p', 'interval', 300000, 5, 1, 1)").run();
		const step = MIGRATIONS[34]!; // scheduled tasks
		expect(typeof step).toBe("string");
		db.exec(step as string);
		expect(db.query("SELECT id, enabled, fail_count, last_status FROM scheduled_tasks").all()).toEqual([{ id: "t", enabled: 1, fail_count: 0, last_status: null }]);
	});

	test("events FK migration removes orphaned rows, preserves valid and global events, and cascades on session delete", () => {
		const db = openDb(":memory:");
		// Simulate a legacy events table without a foreign key
		db.exec(`
			DROP TABLE events;
			CREATE TABLE events (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				type       TEXT NOT NULL,
				data       TEXT NOT NULL,
				ts         INTEGER NOT NULL
			);
			CREATE INDEX events_session ON events(session_id, id);
		`);
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s1', 't', '/', 'p', 'm', 'medium', '', '[]', NULL, 1, 1, 0, '')").run();
		db.query("INSERT INTO events (id, session_id, type, data, ts) VALUES (1, NULL, 'provider_updated', '{}', 10)").run();
		db.query("INSERT INTO events (id, session_id, type, data, ts) VALUES (2, 's1', 'session_created', '{}', 20)").run();
		db.query("INSERT INTO events (id, session_id, type, data, ts) VALUES (3, 'orphan', 'session_updated', '{}', 30)").run();

		const step = MIGRATIONS[42]!;
		expect(typeof step).toBe("function");
		db.transaction(() => (step as (d: typeof db) => void)(db))();

		// Orphaned event removed, global and valid session events preserved with original IDs
		expect(db.query("SELECT id, session_id, type FROM events ORDER BY id").all()).toEqual([
			{ id: 1, session_id: null, type: "provider_updated" },
			{ id: 2, session_id: "s1", type: "session_created" },
		]);
		// Deleting the session cascades to its events, leaving global events intact
		db.query("DELETE FROM sessions WHERE id = 's1'").run();
		expect(db.query("SELECT id, session_id, type FROM events ORDER BY id").all()).toEqual([
			{ id: 1, session_id: null, type: "provider_updated" },
		]);
	});

	test("hot-path indexes exist and survive re-running the migration", () => {
		const db = openDb(":memory:");
		const expected = [
			"idx_events_ts",
			"idx_extension_entries_session_id",
			"idx_messages_session_role_seq",
			"idx_sessions_cwd",
		];
		const listIndexes = () =>
			(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
		for (const idx of expected) expect(listIndexes()).toContain(idx);

		const step = MIGRATIONS[43]!;
		expect(typeof step).toBe("string");
		expect(() => db.exec(step as string)).not.toThrow();
		for (const idx of expected) expect(listIndexes()).toContain(idx);
	});
});
