import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const TOKEN = "ws-test-token-0123456789abcdef0123";
let dir: string;
let app: App;
let url: string;
let port: number;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-ws-"));
	const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: dir, approvalTimeoutMs: 0, logLevel: "silent" };
	app = await buildApp(cfg, { websocket: { heartbeatMs: 60 } });
	const addr = await app.server.listen({ host: "0.0.0.0", port: 0 });
	url = `${addr.replace("http", "ws")}/ws?token=${TOKEN}`;
	port = Number(new URL(addr).port);
	url = `ws://127.0.0.1:${port}/ws?token=${TOKEN}`;
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

/** A well-behaved client: browsers and Bun answer protocol pings on their own. */
const open = async () => {
	const ws = new WebSocket(url);
	const frames: any[] = [];
	ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
	await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
	return { ws, frames };
};
const closed = (ws: WebSocket, ms: number) =>
	new Promise<number | "open">((resolve) => {
		const timer = setTimeout(() => resolve("open"), ms);
		ws.addEventListener("close", (e) => (clearTimeout(timer), resolve(e.code)), { once: true });
	});
const ack = async (frames: any[], id: number) => {
	for (let i = 0; i < 100; i++) {
		const f = frames.find((x) => x.type === "ack" && x.id === id);
		if (f) return f;
		await Bun.sleep(10);
	}
	throw new Error(`no ack ${id}`);
};

/**
 * A client that has gone silent (a phone asleep, a dropped network): a raw socket that completes the handshake, sends one
 * masked text frame, and then never answers a ping. No WebSocket library will do that on purpose.
 */
async function silentClient(firstFrame: string): Promise<{ sock: Socket; ended: Promise<"closed"> }> {
	const sock = connect(port, "127.0.0.1");
	await new Promise((r) => sock.once("connect", r));
	const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
	sock.write(`GET /ws?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
	await new Promise<void>((resolve) => {
		let head = "";
		const on = (d: Buffer) => {
			head += d.toString("latin1");
			if (head.includes("\r\n\r\n")) (sock.off("data", on), resolve());
		};
		sock.on("data", on);
	});
	const payload = Buffer.from(firstFrame);
	const mask = Buffer.from([1, 2, 3, 4]);
	const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
	sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])); // FIN + text, masked, < 126 bytes
	const ended = new Promise<"closed">((r) => sock.once("close", () => r("closed")));
	sock.resume();
	return { sock, ended };
}

describe("websocket heartbeat", () => {
	test("a client that answers pings stays connected", async () => {
		const { ws, frames } = await open();
		expect(await closed(ws, 400)).toBe("open");
		ws.send(JSON.stringify({ id: 1, op: "ping" }));
		expect((await ack(frames, 1)).ok).toBe(true);
		const done = closed(ws, 1000);
		ws.close();
		await done;
	});

	test("a client that stops answering is dropped and its subscriptions are released", async () => {
		const before = app.bus.subscriberCount;
		const { sock, ended } = await silentClient(JSON.stringify({ id: 1, op: "subscribe" }));
		for (let i = 0; i < 50 && app.bus.subscriberCount === before; i++) await Bun.sleep(10);
		expect(app.bus.subscriberCount).toBe(before + 1);
		const outcome = await Promise.race([ended, Bun.sleep(1000).then(() => "still open" as const)]);
		sock.destroy();
		expect(outcome).toBe("closed");
		for (let i = 0; i < 50 && app.bus.subscriberCount !== before; i++) await Bun.sleep(10);
		expect(app.bus.subscriberCount).toBe(before);
	});
});

describe("websocket slow clients", () => {
	test("a client whose queue is over the limit is closed with 1013 so it reconnects and replays", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "pipaya-ws-slow-"));
		const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir2, dbPath: join(dir2, "db.sqlite"), token: TOKEN, workspaceRoot: dir2, approvalTimeoutMs: 0, logLevel: "silent" };
		// a negative limit: every send finds the queue "over", which is the path a stalled phone takes
		const slow = await buildApp(cfg, { websocket: { maxBuffered: -1 } });
		const addr = await slow.server.listen({ host: "0.0.0.0", port: 0 });
		const ws = new WebSocket(`ws://127.0.0.1:${new URL(addr).port}/ws?token=${TOKEN}`);
		const code = await new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
		expect(code).toBe(1013);
		await slow.close();
		rmSync(dir2, { recursive: true, force: true });
	});
});
