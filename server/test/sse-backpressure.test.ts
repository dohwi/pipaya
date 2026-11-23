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

	test("paces large replay bursts across socket drains instead of cutting the reconnecting client off", async () => {
		const bus = new EventBus(openDb(":memory:"));
		// 4 large persisted events whose combined size exceeds maxBuffered (2000 B), like multi-MB image turn events.
		for (let i = 0; i < 4; i++) bus.publish("s1", "message_end", { idx: i, pad: "x".repeat(700) });

		const chunks: string[] = [];
		const res: any = new EventEmitter();
		res.writableLength = 0;
		res.destroyed = false;
		res.writeHead = () => {};
		res.write = (chunk: string) => {
			chunks.push(chunk);
			res.writableLength += Buffer.byteLength(chunk);
			setTimeout(() => {
				if (res.destroyed) return;
				res.writableLength = 0;
				res.emit("drain");
			}, 5);
			return res.writableLength < 1000;
		};
		res.destroy = () => { res.destroyed = true; };

		const raw: any = new EventEmitter();
		const req: any = { query: { after: "0" }, headers: {}, raw };
		const reply: any = { hijack() {}, raw: res };
		streamEvents(req, reply, bus, { corsPolicy: { allows: () => false } as any, maxBuffered: 2000, drainTimeoutMs: 500 });

		// A live event arriving mid-replay is buffered and delivered in order after the replay finishes.
		bus.publish("s1", "turn_end", { idx: 4, pad: "y".repeat(700) });

		for (let i = 0; i < 50 && chunks.filter((c) => c.startsWith("id: ")).length < 5; i++) {
			await Bun.sleep(10);
		}
		expect(res.destroyed).toBe(false);
		const ids = chunks.filter((c) => c.startsWith("id: ")).map((c) => Number(c.split("\n")[0]!.slice(4)));
		expect(ids).toEqual([1, 2, 3, 4, 5]);
		raw.emit("close");
	});

	test("drops a replay client whose socket never drains within drainTimeoutMs", async () => {
		const bus = new EventBus(openDb(":memory:"));
		for (let i = 0; i < 4; i++) bus.publish("s1", "message_end", { pad: "x".repeat(700) });

		const res = stalledResponse();
		const raw: any = new EventEmitter();
		const req: any = { query: {}, headers: {}, raw };
		req.query.after = "0";
		const reply: any = { hijack() {}, raw: res };
		streamEvents(req, reply, bus, { corsPolicy: { allows: () => false } as any, maxBuffered: 2000, drainTimeoutMs: 30 });

		for (let i = 0; i < 20 && !res.destroyed; i++) await Bun.sleep(10);
		expect(res.destroyed).toBe(true);
	});

	test("emits named ping events on open and periodically so clients can detect half-open streams", async () => {
		const bus = new EventBus(openDb(":memory:"));
		const chunks: string[] = [];
		const res: any = new EventEmitter();
		res.writableLength = 0;
		res.destroyed = false;
		res.writeHead = () => {};
		res.write = (chunk: string) => { chunks.push(chunk); return true; };
		res.destroy = () => { res.destroyed = true; };

		const raw: any = new EventEmitter();
		const req: any = { query: { ping: "1" }, headers: {}, raw };
		const reply: any = { hijack() {}, raw: res };
		streamEvents(req, reply, bus, { corsPolicy: { allows: () => false } as any, heartbeatMs: 25 });

		// Initial ping arrives immediately on open.
		expect(chunks.some((c) => c.startsWith("event: ping\n"))).toBe(true);
		const initialPings = chunks.filter((c) => c.startsWith("event: ping\n")).length;
		await Bun.sleep(65);
		expect(chunks.filter((c) => c.startsWith("event: ping\n")).length).toBeGreaterThan(initialPings);
		raw.emit("close");
	});
});
