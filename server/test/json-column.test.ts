import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/events.ts";
import { mapRows, parseJson } from "../src/json-column.ts";
import { openDb } from "../src/db.ts";
import { SqliteCredentialStore } from "../src/store.ts";

describe("json-column", () => {
	test("parseJson returns the fallback for damaged text", () => {
		expect(parseJson<{ a: number } | null>('{"a":1}', null)).toEqual({ a: 1 });
		expect(parseJson("{oops", [] as string[])).toEqual([]);
	});

	test("mapRows drops only the rows that throw and reports them", () => {
		const skipped: string[] = [];
		const out = mapRows(["1", "x", "3"], (s) => JSON.parse(s) as number, (row) => skipped.push(row));
		expect(out).toEqual([1, 3]);
		expect(skipped).toEqual(["x"]);
	});

	test("one damaged event does not break the replay of the others", () => {
		const db = openDb(":memory:");
		const bus = new EventBus(db);
		bus.publish(null, "a", { n: 1 });
		db.query("INSERT INTO events (session_id, type, data, ts) VALUES (NULL, 'bad', '{oops', 1)").run();
		bus.publish(null, "c", { n: 3 });
		expect(bus.history({ after: 0, limit: 10 }).map((e) => e.type)).toEqual(["a", "c"]);
	});

	test("credential updates stay serialised per provider and leave no queue behind", async () => {
		const store = new SqliteCredentialStore(openDb(":memory:"));
		const order: string[] = [];
		const slow = store.modify("p", async () => { await Bun.sleep(20); order.push("first"); return { type: "api_key", key: "1" } as never; });
		const fast = store.modify("p", async () => { order.push("second"); return { type: "api_key", key: "2" } as never; });
		await Promise.all([slow, fast]);
		expect(order).toEqual(["first", "second"]);
		await Bun.sleep(0);
		expect((store as unknown as { chains: Map<string, unknown> }).chains.size).toBe(0);
		await store.delete("p");
		expect(await store.read("p")).toBeUndefined();
	});
});
