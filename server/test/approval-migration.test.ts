import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { SessionStore, type SessionRecord } from "../src/store.ts";

describe("approval policy migration", () => {
	test("read-only (no longer offered) folds into ask for sessions and for the saved default; auto stays", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-approval-"));
		const path = join(dir, "db.sqlite");
		let db = openDb(path);
		try {
			const record: SessionRecord = {
				id: "ro", title: "t", name: "t", cwd: dir, provider: "custom", model: "manual", thinkingLevel: "medium",
				systemPrompt: "p", tools: ["read"], approval: "readonly", parentId: null, closed: false, createdAt: 1, updatedAt: 2,
			};
			const store = new SessionStore(db);
			store.create(record);
			store.create({ ...record, id: "auto", approval: "auto" });
			db.exec(`INSERT INTO settings (key, data) VALUES ('default_approval', '"readonly"'); PRAGMA user_version = 16`);
			db.close();
			db = openDb(path);
			const migrated = new SessionStore(db);
			expect(migrated.get("ro")?.approval).toBe("ask");
			expect(migrated.get("auto")?.approval).toBe("auto");
			expect(db.query("SELECT data FROM settings WHERE key = 'default_approval'").get()).toBeNull();
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a saved auto default survives the migration", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-approval-"));
		const path = join(dir, "db.sqlite");
		let db = openDb(path);
		try {
			db.exec(`INSERT INTO settings (key, data) VALUES ('default_approval', '"auto"'); PRAGMA user_version = 16`);
			db.close();
			db = openDb(path);
			expect(db.query("SELECT data FROM settings WHERE key = 'default_approval'").get()).toEqual({ data: '"auto"' });
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
