import { describe, expect, test } from "bun:test";
import { MIGRATIONS, openDb } from "../src/db.ts";

const schema = (db: ReturnType<typeof openDb>) => JSON.stringify(db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());

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
});
