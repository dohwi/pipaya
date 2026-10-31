import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { streamEvents } from "../src/sse.ts";

/** A response that never drains: every write stays queued, as for a phone that went away without closing. */
function stalledResponse() {
	const res: any = new EventEmitter();
	res.writableLength = 0;
	res.destroyed = false;
	res.writeHead = () => {};
	res.write = (chunk: string) => { res.writableLength += chunk.length; return false; };
	res.destroy = () => { res.destroyed = true; };
	return res;
}

describe("SSE slow client", () => {
	test("is cut off once its queue passes the limit, and stops receiving events", () => {
		const bus = new EventBus(openDb(":memory:"));
		const res = stalledResponse();
		const raw: any = new EventEmitter();
		const req: any = { query: {}, headers: {}, raw };
		const reply: any = { hijack() {}, raw: res };
		streamEvents(req, reply, bus, { corsPolicy: { allows: () => false } as any, maxBuffered: 2000 });
		let sent = 0;
		for (let i = 0; i < 100 && !res.destroyed; i++) { bus.publish(null, "ping", { pad: "x".repeat(200) }); sent++; }
		expect(res.destroyed).toBe(true);
		expect(sent).toBeLessThan(100);
		const queued = res.writableLength;
		bus.publish(null, "ping", { pad: "late" });
		expect(res.writableLength).toBe(queued);
	});
});
