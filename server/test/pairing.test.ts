import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { DeviceTokens } from "../src/device-tokens.ts";
import { openDb } from "../src/db.ts";
import { MAX_ACTIVE_CODES, PAIRING_TTL_MS, Pairing } from "../src/pairing.ts";

let app: App;
let dir: string;
const call = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({ method, url, headers: { ...(auth ? { authorization: "Bearer test-token" } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-pairing-"));
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("pairing over HTTP", () => {
	test("creating a code needs the token; redeeming it does not, and returns the token once", async () => {
		expect((await call("POST", "/pairing", undefined, false)).status).toBe(401);
		const made = await call("POST", "/pairing");
		expect(made.status).toBe(200);
		expect(made.json.expiresAt).toBeGreaterThan(Date.now());
		const redeemed = await call("POST", "/pairing/redeem", { code: made.json.code }, false);
		expect(redeemed.status).toBe(200);
		expect(redeemed.json.token.startsWith("hdt_")).toBe(true); // a token of its own, never the admin token
		expect(redeemed.json.token).not.toBe("test-token");
		expect((await call("POST", "/pairing/redeem", { code: made.json.code }, false)).status).toBe(403); // used up
	});
	test("a wrong code is refused", async () => {
		expect((await call("POST", "/pairing/redeem", { code: "not-a-real-code" }, false)).status).toBe(403);
	});
	test("closing the dialog invalidates open codes", async () => {
		const { json } = await call("POST", "/pairing");
		await call("DELETE", "/pairing");
		expect((await call("POST", "/pairing/redeem", { code: json.code }, false)).status).toBe(403);
	});
	test("other routes stay closed without the token", async () => {
		expect((await call("GET", "/sessions", undefined, false)).status).toBe(401);
		expect((await call("GET", "/pairing/redeem", undefined, false)).status).toBe(401);
	});
});

describe("pairing rules", () => {
	test("a code expires after two minutes", () => {
		let t = 1000;
		const p = new Pairing(() => "tok", () => t);
		const { code } = p.create();
		t += PAIRING_TTL_MS - 1;
		expect(p.redeem(code)).toBe("tok");
		const second = p.create().code;
		t += PAIRING_TTL_MS + 1;
		expect(() => p.redeem(second)).toThrow();
	});
	test("only a few codes are open at once; the oldest makes room", () => {
		const p = new Pairing(() => "tok");
		const codes = Array.from({ length: MAX_ACTIVE_CODES + 1 }, () => p.create().code);
		expect(() => p.redeem(codes[0]!)).toThrow();
		expect(p.redeem(codes.at(-1)!)).toBe("tok");
	});
	test("guessing is throttled for everyone, even for a correct code, until the window passes", () => {
		let t = 0;
		const p = new Pairing(() => "tok", () => t);
		const { code } = p.create();
		for (let i = 0; i < 10; i++) expect(() => p.redeem(`wrong-guess-${i}`)).toThrow("not valid");
		expect(() => p.redeem(code)).toThrow("too many");
		t += 61_000;
		expect(p.redeem(code)).toBe("tok");
	});

	test("one noisy caller is throttled without locking out the owner", () => {
		const t = 0;
		const p = new Pairing(() => "tok", () => t);
		const { code } = p.create();
		for (let i = 0; i < 10; i++) expect(() => p.redeem(`wrong-${i}`, "203.0.113.9")).toThrow("not valid");
		expect(() => p.redeem(code, "203.0.113.9")).toThrow("too many");
		expect(p.redeem(code, "192.168.0.5")).toBe("tok"); // the owner on the LAN still gets in
	});

	test("many callers together are still capped", () => {
		const p = new Pairing(() => "tok", () => 0);
		const { code } = p.create();
		for (let i = 0; i < 100; i++) expect(() => p.redeem(`wrong-${i}`, `10.0.${i % 50}.${i}`)).toThrow("not valid");
		expect(() => p.redeem(code, "192.168.0.5")).toThrow("too many");
	});
});

describe("per-device tokens over HTTP", () => {
	const as = async (token: string, method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	const pair = async (name?: string) => {
		const { json } = await call("POST", "/pairing");
		return (await call("POST", "/pairing/redeem", { code: json.code, ...(name ? { name } : {}) }, false)).json.token as string;
	};

	test("a device token works for ordinary routes", async () => {
		const token = await pair("Pixel 9");
		expect((await as(token, "GET", "/sessions")).status).toBe(200);
	});
	test("a device token cannot pair more phones or manage tokens", async () => {
		const token = await pair();
		expect((await as(token, "POST", "/pairing")).status).toBe(403);
		expect((await as(token, "DELETE", "/pairing")).status).toBe(403);
		expect((await as(token, "GET", "/devices/tokens")).status).toBe(403);
		expect((await as(token, "DELETE", "/devices/tokens/anything")).status).toBe(403);
	});
	test("a device token cannot reload or install server extensions", async () => {
		const token = await pair();
		expect((await as(token, "POST", "/server-extensions/reload")).status).toBe(403);
		expect((await as(token, "POST", "/server-extensions/install", { id: "x", repo: "a/b", ref: "v1", commit: "a".repeat(40) })).status).toBe(403);
	});
	test("the admin lists tokens by name (never the secret) and revoking one locks only that device out", async () => {
		const a = await pair("Phone A");
		const b = await pair("Phone B");
		const listed = await call("GET", "/devices/tokens");
		expect(listed.status).toBe(200);
		expect(JSON.stringify(listed.json)).not.toContain(a);
		const phoneA = listed.json.tokens.find((t: any) => t.name === "Phone A");
		expect(phoneA).toBeTruthy();
		expect((await call("DELETE", `/devices/tokens/${phoneA.id}`)).status).toBe(200);
		expect((await as(a, "GET", "/sessions")).status).toBe(401);
		expect((await as(b, "GET", "/sessions")).status).toBe(200);
		expect((await call("DELETE", `/devices/tokens/${phoneA.id}`)).status).toBe(404);
	});
	test("an unknown or malformed token is refused", async () => {
		expect((await as("hdt_not-a-real-token", "GET", "/sessions")).status).toBe(401);
		expect((await as("x".repeat(500), "GET", "/sessions")).status).toBe(401);
	});
	test("/health shows load figures to a device token as well", async () => {
		const token = await pair();
		expect(typeof (await as(token, "GET", "/health")).json.runningSessions).toBe("number");
	});
});

describe("DeviceTokens", () => {
	test("only a hash is stored, and revoking hangs up that device's open connections", () => {
		const db = openDb(":memory:");
		const tokens = new DeviceTokens(db);
		const { id, token } = tokens.issue("  Tab\u0000let \n one ");
		const stored = JSON.stringify(db.query("SELECT * FROM device_tokens").all());
		expect(stored).not.toContain(token);
		expect(tokens.list()[0]?.name).toBe("Tab let one");
		expect(tokens.verify(token)).toBe(id);
		let destroyed = 0;
		const listeners: (() => void)[] = [];
		const socket: any = { once: (_: string, f: () => void) => listeners.push(f), destroy: () => destroyed++ };
		tokens.track(id, socket);
		tokens.track(id, socket);
		expect(tokens.revoke(id)).toBe(true);
		expect(destroyed).toBe(1);
		expect(tokens.verify(token)).toBeNull();
	});
});
