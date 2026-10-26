import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db.ts";
import { SessionStore, THINKING_LEVELS, type SessionRecord } from "../src/store.ts";

describe("thinking levels", () => {
	test("supported strengths exclude off", () => {
		expect([...THINKING_LEVELS]).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	test("v3 sessions with off migrate to medium without changing other strengths or settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-thinking-"));
		const path = join(dir, "db.sqlite");
		let db = openDb(path);
		try {
			const store = new SessionStore(db);
			const record: SessionRecord = {
				id: "legacy-off", title: "Keep my title", cwd: dir, provider: "custom", model: "manual",
				thinkingLevel: "medium", systemPrompt: "Keep my prompt", tools: ["read"],
				purpose: "", parentId: null, closed: false, archived: false, createdAt: 100, updatedAt: 200,
			};
			store.create(record);
			store.create({ ...record, id: "existing-high", thinkingLevel: "high" });
			// The rewind below replays old migrations, which still read the approval column that the newest one drops.
			db.exec("ALTER TABLE sessions ADD COLUMN approval TEXT NOT NULL DEFAULT 'auto'; UPDATE sessions SET thinking_level = 'off' WHERE id = 'legacy-off'; PRAGMA user_version = 3");
			db.close();
			db = openDb(path);
			const migrated = new SessionStore(db);
			expect(migrated.get("legacy-off")).toEqual(record);
			expect(migrated.get("existing-high")?.thinkingLevel).toBe("high");
			expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
			db.close();
			db = openDb(path);
			expect(new SessionStore(db).get("legacy-off")?.thinkingLevel).toBe("medium");
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
