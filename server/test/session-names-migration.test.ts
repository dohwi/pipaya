import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MIGRATIONS, openDb } from "../src/db.ts";

// Steps are applied in order and `user_version` counts how many have run, so "just before step N" is N. The two steps are found by what they do.
const stepIndex = (needle: string) => MIGRATIONS.findIndex((m) => typeof m === "function" && m.toString().includes(needle));
// the table is created by the string step just before the one that fills it, so the rewind goes back one more
const MOVE_NAMES = stepIndex("'peer-tools'") - 1;
const DROP_GROUP_NAMES = stepIndex("DROP COLUMN names");

// Databases written before names left the core carry sessions.name; the migration hands the names of active sessions to peer-tools.
test("session @names move to the peer-tools values and the column goes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pipaya-names-"));
	const path = join(dir, "db.sqlite");
	try {
		const fresh = openDb(path);
		fresh.close();
		const old = new Database(path, { strict: true });
		old.exec("DROP TABLE extension_session_data; ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT ''");
		const put = old.query("INSERT INTO sessions (id, title, purpose, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at, name) VALUES ($id, 't', '', '/', 'p', 'm', 'low', '', '[]', $closed, 1, 1, $name)");
		put.run({ id: "a", closed: 0, name: "미나" });
		put.run({ id: "b", closed: 1, name: "철수" });
		put.run({ id: "c", closed: 0, name: "" });
		// rewind to just before the step that moves the names
		old.exec(`PRAGMA user_version = ${MOVE_NAMES}`);
		old.close();

		const db = openDb(path);
		expect((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).some((c) => c.name === "name")).toBe(false);
		const rows = db.query("SELECT session_id, extension, key, value FROM extension_session_data").all();
		expect(rows).toEqual([{ session_id: "a", extension: "peer-tools", key: "name", value: JSON.stringify("미나") }]);
		expect((db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(3);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// groups.names has had no reader since the names left the core; the migration removes the column and keeps the groups.
test("the unused groups.names column is dropped without touching groups", () => {
	const dir = mkdtempSync(join(tmpdir(), "pipaya-gnames-"));
	const path = join(dir, "db.sqlite");
	try {
		const fresh = openDb(path);
		fresh.close();
		const old = new Database(path, { strict: true });
		old.exec("ALTER TABLE groups ADD COLUMN names TEXT NOT NULL DEFAULT '{}'");
		old.query("INSERT INTO groups (id, name, layout, created_at, updated_at, names) VALUES ('g', 'Team', '{}', 1, 1, '{\"a\":\"x\"}')").run();
		old.exec(`PRAGMA user_version = ${DROP_GROUP_NAMES}`);
		old.close();

		const db = openDb(path);
		expect((db.query("PRAGMA table_info(groups)").all() as { name: string }[]).some((c) => c.name === "names")).toBe(false);
		expect(db.query("SELECT id, name FROM groups").all()).toEqual([{ id: "g", name: "Team" }]);
		db.close();
		openDb(path).close(); // idempotent
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
