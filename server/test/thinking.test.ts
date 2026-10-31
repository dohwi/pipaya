import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db.ts";
import { SessionStore, THINKING_LEVELS, type SessionRecord } from "../src/store.ts";
import { reasoningOption } from "../src/models.ts";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";

describe("thinking levels", () => {
	test("'off' asks for no reasoning: nothing is sent, so the provider keeps its own default", () => {
		const model = { reasoning: true } as any;
		expect(reasoningOption("off", model)).toEqual({});
		expect(reasoningOption(undefined, model)).toEqual({});
		expect(reasoningOption("high", { reasoning: false } as any)).toEqual({});
		expect(reasoningOption("high", model)).toEqual({ reasoning: "high" });
	});

	test("covers every strength the engine knows, in its order", () => {
		// A new level upstream (an "ultra", say) makes this fail: add it here and in the client's THINKING_LEVELS.
		expect([...THINKING_LEVELS]).toEqual([...MODEL_THINKING_LEVELS]);
	});

	test("v3 sessions with off migrate to medium without changing other strengths or settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "pipaya-thinking-"));
		const path = join(dir, "db.sqlite");
		let db = openDb(path);
		try {
			const store = new SessionStore(db);
			const record: SessionRecord = {
				id: "legacy-off", name: "", title: "Keep my title", cwd: dir, provider: "custom", model: "manual",
				thinkingLevel: "medium", systemPrompt: "Keep my prompt", tools: ["read"],
				purpose: "", parentId: null, closed: false, archived: false, createdAt: 100, updatedAt: 200,
			};
			store.create(record);
			store.create({ ...record, id: "existing-high", thinkingLevel: "high" });
			// Rewinding to version 3 replays every later migration, including the ones that read or drop columns that are already gone.
			db.exec("UPDATE sessions SET thinking_level = 'off' WHERE id = 'legacy-off'; PRAGMA user_version = 3");
			db.close();
			db = openDb(path);
			const migrated = new SessionStore(db);
			expect(migrated.get("legacy-off")).toEqual({ ...record, name: "미나" }); // migrations name the active sessions that have none
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
