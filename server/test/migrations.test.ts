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
		for (const step of MIGRATIONS.slice(-3, -1)) { // v30 and v31: Korean names, then pairs (v32, scheduled tasks, is SQL and has no part in this)
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

	test("scheduled tasks: the table is created by the last step, which can run again and keeps the rows", () => {
		const db = openDb(":memory:");
		db.query("INSERT INTO sessions (id, title, cwd, provider, model, thinking_level, system_prompt, tools, parent_id, created_at, updated_at, closed, purpose) VALUES ('s', 't', '/', 'p', 'm', 'off', '', '[]', NULL, 1, 1, 0, '')").run();
		db.query("INSERT INTO scheduled_tasks (id, session_id, prompt, kind, every_ms, next_run_at, created_at, updated_at) VALUES ('t', 's', 'p', 'interval', 300000, 5, 1, 1)").run();
		const last = MIGRATIONS[MIGRATIONS.length - 1]!;
		expect(typeof last).toBe("string");
		db.exec(last as string);
		expect(db.query("SELECT id, enabled, fail_count, last_status FROM scheduled_tasks").all()).toEqual([{ id: "t", enabled: 1, fail_count: 0, last_status: null }]);
	});
});
