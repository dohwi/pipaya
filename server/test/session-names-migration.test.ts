import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";

// Databases written before names left the core carry sessions.name; the migration hands the names of active sessions to peer-tools.
test("session @names move to the peer-tools values and the column goes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pipaya-names-"));
	const path = join(dir, "db.sqlite");
	try {
		const fresh = openDb(path);
		const latest = (fresh.query("PRAGMA user_version").get() as { user_version: number }).user_version;
		fresh.close();
		const old = new Database(path, { strict: true });
		old.exec("DROP TABLE extension_session_data; ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT ''");
		const put = old.query("INSERT INTO sessions (id, title, purpose, cwd, provider, model, thinking_level, system_prompt, tools, closed, created_at, updated_at, name) VALUES ($id, 't', '', '/', 'p', 'm', 'low', '', '[]', $closed, 1, 1, $name)");
		put.run({ id: "a", closed: 0, name: "미나" });
		put.run({ id: "b", closed: 1, name: "철수" });
		put.run({ id: "c", closed: 0, name: "" });
		old.exec(`PRAGMA user_version = ${latest - 2}`);
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
