import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { redactUrl } from "../src/security.ts";
import { MAX_STREAM_TICKETS, STREAM_TICKET_TTL_MS, StreamTickets } from "../src/stream-tickets.ts";

describe("StreamTickets", () => {
	test("a ticket opens one connection and names who asked", () => {
		const tickets = new StreamTickets();
		const admin = tickets.issue({ device: null }).ticket;
		const phone = tickets.issue({ device: "abc" }).ticket;
		expect(tickets.redeem(admin)).toEqual({ device: null });
		expect(tickets.redeem(admin)).toBeNull();
		expect(tickets.redeem(phone)).toEqual({ device: "abc" });
		expect(tickets.redeem("made-up")).toBeNull();
		expect(tickets.redeem(undefined)).toBeNull();
	});
	test("a ticket expires after half a minute", () => {
		let now = 1_000;
		const tickets = new StreamTickets(() => now);
		const a = tickets.issue({ device: null });
		expect(a.expiresAt).toBe(1_000 + STREAM_TICKET_TTL_MS);
		now += STREAM_TICKET_TTL_MS;
		expect(tickets.redeem(a.ticket)).toBeNull();
		const b = tickets.issue({ device: null });
		now += STREAM_TICKET_TTL_MS - 1;
		expect(tickets.redeem(b.ticket)).toEqual({ device: null });
	});
	test("revoking a device drops the tickets it asked for and nobody else's", () => {
		const tickets = new StreamTickets();
		const gone = tickets.issue({ device: "gone" }).ticket;
		const kept = tickets.issue({ device: "kept" }).ticket;
		const admin = tickets.issue({ device: null }).ticket;
		tickets.revokeDevice("gone");
		expect(tickets.redeem(gone)).toBeNull();
		expect(tickets.redeem(kept)).toEqual({ device: "kept" });
		expect(tickets.redeem(admin)).toEqual({ device: null });
	});
	test("unused tickets do not pile up: the oldest make room", () => {
		const tickets = new StreamTickets();
		const first = tickets.issue({ device: null }).ticket;
		for (let i = 0; i < MAX_STREAM_TICKETS; i++) tickets.issue({ device: null });
		expect(tickets.redeem(first)).toBeNull();
	});
	test("a ticket in a URL never reaches the request log", () => {
		expect(redactUrl("/events?after=3&ticket=abc123")).toBe("/events?after=3&ticket=[redacted]");
		expect(redactUrl("/terminals/t/ws?ticket=abc&protocol=1")).toBe("/terminals/t/ws?ticket=[redacted]&protocol=1");
	});
});

describe("stream tickets over HTTP", () => {
	const TOKEN = "stream-ticket-test-token-0123456789";
	let app: App;
	let dir: string;
	let base: string;
	const post = async (path: string, token: string | null, body?: unknown) => {
		const r = await fetch(base + path, {
			method: "POST",
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		return { status: r.status, json: (await r.json().catch(() => undefined)) as any };
	};
	/** Status of opening the event stream with this query; the stream is dropped right away. */
	const open = async (query: string) => {
		const ctrl = new AbortController();
		const r = await fetch(`${base}/events?${query}`, { signal: ctrl.signal });
		ctrl.abort();
		return r.status;
	};
	const ticketFor = async (token: string) => (await post("/stream-tickets", token)).json.ticket as string;
	const pair = async () => {
		const code = (await post("/pairing", TOKEN)).json.code as string;
		return (await post("/pairing/redeem", null, { code, name: "Phone" })).json.token as string;
	};

	beforeAll(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pipaya-tickets-")));
		const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: dir, logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, home: dir, builtinSkills: false, extensionDirs: [] });
		base = await app.server.listen({ host: "127.0.0.1", port: 0 });
	});
	afterAll(async () => {
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("asking for a ticket needs a token", async () => {
		expect((await post("/stream-tickets", null)).status).toBe(401);
		expect((await post("/stream-tickets", "wrong")).status).toBe(401);
		const r = await post("/stream-tickets", TOKEN);
		expect(r.status).toBe(200);
		expect(typeof r.json.ticket).toBe("string");
		expect(r.json.expiresAt).toBeGreaterThan(Date.now());
	});
	test("a ticket opens the event stream once", async () => {
		const ticket = await ticketFor(TOKEN);
		expect(await open(`ticket=${ticket}`)).toBe(200);
		expect(await open(`ticket=${ticket}`)).toBe(401);
		expect(await open("ticket=made-up")).toBe(401);
	});
	test("a ticket is no credential for ordinary routes", async () => {
		const ticket = await ticketFor(TOKEN);
		expect((await fetch(`${base}/sessions?ticket=${ticket}`)).status).toBe(401);
		// ...and asking there did not spend it
		expect(await open(`ticket=${ticket}`)).toBe(200);
	});
	test("clients from before tickets still connect with the token in the query", async () => {
		expect(await open(`token=${TOKEN}`)).toBe(200);
	});
	test("a paired device gets its own ticket, which dies with the device", async () => {
		const device = await pair();
		expect(await open(`ticket=${await ticketFor(device)}`)).toBe(200);
		const pending = await ticketFor(device);
		// Through inject, not fetch: revoking hangs up the sockets the device used, and fetch would reuse one of them.
		const admin = { authorization: `Bearer ${TOKEN}` };
		const id = (await app.server.inject({ method: "GET", url: "/devices/tokens", headers: admin })).json().tokens[0].id as string;
		expect((await app.server.inject({ method: "DELETE", url: `/devices/tokens/${id}`, headers: admin })).statusCode).toBe(200);
		expect(await open(`ticket=${pending}`)).toBe(401);
	});
	test("a terminal socket accepts a ticket", async () => {
		// A plain POSIX shell from the server's own list keeps the user's rc files out of the test.
		const shells = ((await (await fetch(`${base}/terminals/info`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any).shells as { name: string; path: string }[];
		const made = await post("/terminals", TOKEN, { shell: (shells.find((s) => s.name === "sh") ?? shells[0])!.path });
		expect(made.status).toBe(201);
		const ticket = await ticketFor(TOKEN);
		const ws = new WebSocket(`${base.replace("http", "ws")}/terminals/${made.json.id}/ws?ticket=${ticket}`);
		const hello = await new Promise<string>((resolve, reject) => {
			ws.onmessage = (m) => typeof m.data === "string" && resolve(JSON.parse(m.data).type);
			ws.onerror = () => reject(new Error("socket refused"));
			setTimeout(() => reject(new Error("timed out")), 5000);
		});
		expect(hello).toBe("hello");
		ws.close();
		await fetch(`${base}/terminals/${made.json.id}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
	});
});
