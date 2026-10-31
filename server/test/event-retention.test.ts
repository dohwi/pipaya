import { describe, expect, test } from "bun:test";
import { EVENT_RETENTION_MS } from "../src/app.ts";
import { EventBus } from "../src/events.ts";
import { openDb } from "../src/db.ts";

describe("event retention", () => {
	test("prune drops only events older than the retention window", () => {
		const db = openDb(":memory:");
		const bus = new EventBus(db);
		const old = bus.publish(null, "ping", { n: 1 });
		db.query("UPDATE events SET ts = $ts WHERE id = $id").run({ ts: Date.now() - EVENT_RETENTION_MS - 60_000, id: old.id });
		const fresh = bus.publish(null, "ping", { n: 2 });
		expect(bus.prune(EVENT_RETENTION_MS)).toBe(1);
		expect(bus.history({ after: 0, limit: 10 }).map((e) => e.id)).toEqual([fresh.id]);
		expect(bus.latestId()).toBe(fresh.id);
	});

	test("ids keep growing after everything was pruned, so a client's cursor never points at a reused id", () => {
		const db = openDb(":memory:");
		const bus = new EventBus(db);
		const last = bus.publish(null, "ping", {}).id;
		db.query("UPDATE events SET ts = 0").run();
		expect(bus.prune(EVENT_RETENTION_MS)).toBe(1);
		expect(bus.latestId()).toBe(last);
		expect(bus.publish(null, "ping", {}).id).toBeGreaterThan(last);
	});
});
