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

	test("a pair like Cheolsu / 철수 among the active sessions is split: the oldest keeps the name, closed ones are left alone", () => {
		const db = openDb(":memory:");
		const add = db.query("INSERT INTO sessions (id, title, name, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at) VALUES ($id, 't', $name, '/', 'p', 'm', 'off', '', '[]', $closed, $at, $at)");
		add.run({ id: "a", name: "Cheolsu", closed: 0, at: 1 });
		add.run({ id: "b", name: "철수", closed: 0, at: 2 });
		add.run({ id: "c", name: "Mina", closed: 0, at: 3 });
		add.run({ id: "d", name: "미나", closed: 0, at: 4 });
		add.run({ id: "e", name: "철수", closed: 1, at: 5 }); // closed: gave its name up, stays as it is
		add.run({ id: "f", name: "가온", closed: 0, at: 6 });
		for (const step of MIGRATIONS.slice(32, 34)) { // v30 and v31: Korean names, then pairs (v32, scheduled tasks, is SQL and has no part in this)
			if (typeof step !== "string") step(db);
		}
		const names = Object.fromEntries((db.query("SELECT id, name FROM sessions").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
		expect(names.a).toBe("철수");
		expect(names.c).toBe("미나"); // keeps its name: only the duplicates (b, d) move
		expect(names.e).toBe("철수");
		expect(names.f).toBe("가온");
		expect(names.b).not.toBe("철수");
		expect(names.d).not.toBe("미나");
		const active = ["a", "b", "c", "d", "f"].map((id) => names[id]!);
		expect(new Set(active).size).toBe(5); // no two active sessions share a name any more
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 6 }); // nothing deleted
	});

	test("no two sessions share a name, closed ones included: an open one keeps it, else the oldest closed one", () => {
		const db = openDb(":memory:");
		const add = db.query("INSERT INTO sessions (id, title, name, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at) VALUES ($id, 't', $name, '/', 'p', 'm', 'off', '', '[]', $closed, $at, $at)");
		add.run({ id: "old", name: "철수", closed: 1, at: 1 }); // closed, then an open session took its name
		add.run({ id: "open", name: "철수", closed: 0, at: 2 });
		add.run({ id: "c1", name: "미나", closed: 1, at: 3 }); // two closed holders: the older one keeps it
		add.run({ id: "c2", name: "Mina", closed: 1, at: 4 });
		add.run({ id: "solo", name: "가온", closed: 1, at: 5 }); // nobody else has it: untouched
		add.run({ id: "none", name: "", closed: 1, at: 6 }); // never had one: stays without
		const step = MIGRATIONS[38]!;
		if (typeof step !== "string") step(db);
		const names = () => Object.fromEntries((db.query("SELECT id, name FROM sessions").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
		const after = names();
		expect(after.open).toBe("철수");
		expect(after.c1).toBe("미나");
		expect(after.solo).toBe("가온");
		expect(after.none).toBe("");
		expect(["철수", "미나", "가온"]).not.toContain(after.old);
		expect(["철수", "미나", "가온", after.old]).not.toContain(after.c2);
		// running it again changes nothing
		if (typeof step !== "string") step(db);
		expect(names()).toEqual(after);
		expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 6 });
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
});
