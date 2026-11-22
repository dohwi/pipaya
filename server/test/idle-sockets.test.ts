import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import * as photon from "@silvia-odwyer/photon-node";
import { IdleSockets } from "../src/idle-sockets.ts";
import { resizeImage } from "../src/image-resize.ts";

let clock = 0;
let idle: IdleSockets;
let server: Server;
let port: number;
let release: (() => void) | undefined;

beforeAll(async () => {
	idle = new IdleSockets(1000, () => clock);
	server = createServer((req, res) => {
		idle.requestStarted(req.socket, req);
		if (req.url === "/slow") release = () => res.end("slow");
		else res.end("ok");
	});
	idle.attach(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

const open = () =>
	new Promise<{ socket: Socket; closed: Promise<void>; body: () => string }>((resolve) => {
		let data = "";
		const socket = connect(port, "127.0.0.1", () => resolve({ socket, closed, body: () => data }));
		socket.on("data", (d) => (data += d));
		const closed = new Promise<void>((r) => socket.on("close", () => r()));
	});
const until = async (ok: () => boolean) => {
	for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(10);
	expect(ok()).toBe(true);
};

test("an idle keep-alive socket is closed, one with a request in flight is kept", async () => {
	const quiet = await open();
	const busy = await open();
	quiet.socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
	busy.socket.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
	await until(() => quiet.body().includes("ok") && release !== undefined);

	clock += 999;
	expect(idle.sweep()).toBe(0);
	clock += 1;
	expect(idle.sweep()).toBe(1); // the quiet one; the slow request still runs
	await quiet.closed;
	expect(busy.socket.destroyed).toBe(false);

	release!();
	await until(() => busy.body().includes("slow"));
	clock += 1000;
	expect(idle.sweep()).toBe(1);
	await busy.closed;
	expect(idle.size).toBe(0);
});

test("resizing reuses one worker instead of leaking file descriptors per picture", async () => {
	if (process.platform !== "linux") return;
	const px = new Uint8Array(64 * 64 * 4).fill(200);
	const png = new Uint8Array(new photon.PhotonImage(px, 64, 64).get_bytes());
	const fds = () => require("node:fs").readdirSync("/proc/self/fd").length;
	await resizeImage(png, { maxWidth: 16, maxHeight: 16 }); // the worker is started once
	const before = fds();
	for (let i = 0; i < 8; i++) expect(await resizeImage(png, { maxWidth: 16, maxHeight: 16 })).not.toBeNull();
	expect(fds()).toBeLessThanOrEqual(before + 1);
});

test("an aborted resize resolves to null and the worker keeps serving", async () => {
	const px = new Uint8Array(32 * 32 * 4).fill(10);
	const png = new Uint8Array(new photon.PhotonImage(px, 32, 32).get_bytes());
	const ac = new AbortController();
	const gone = resizeImage(png, { maxWidth: 8, maxHeight: 8 }, ac.signal);
	ac.abort();
	expect(await gone).toBeNull();
	expect(await resizeImage(png, { maxWidth: 8, maxHeight: 8 })).not.toBeNull();
});

test("ignores synthetic or missing sockets without destroy() (e.g. Fastify inject)", () => {
	let t = 0;
	const local = new IdleSockets(1000, () => t);
	const done = { once: (_ev: "close", fn: () => void) => fn() };
	local.requestStarted(undefined, done);
	local.requestStarted({} as Socket, done);
	t += 2000;
	expect(() => local.sweep()).not.toThrow();
	expect(local.size).toBe(0);
});
