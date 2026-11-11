import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { AUTH_FAILURE_WINDOW_MS, AUTH_MAX_FAILURES, AuthThrottle, isLoopback } from "../src/auth-throttle.ts";
import type { Config } from "../src/config.ts";

describe("AuthThrottle", () => {
	test("a caller is turned away after too many different wrong tokens, until the oldest leaves the window", () => {
		let now = 0;
		const throttle = new AuthThrottle(3, 1000, () => now);
		for (let i = 0; i < 3; i++) {
			expect(throttle.blockedFor("10.0.0.1")).toBe(0);
			throttle.fail("10.0.0.1", `guess-${i}`);
			now += 100;
		}
		// guesses at 0, 100, 200; now 300: the one at 0 leaves at 1000
		expect(throttle.blockedFor("10.0.0.1")).toBe(700);
		now = 999;
		expect(throttle.blockedFor("10.0.0.1")).toBe(1);
		now = 1000;
		expect(throttle.blockedFor("10.0.0.1")).toBe(0);
	});
	test("the same wrong token again is the same guess: a revoked device that keeps asking locks nobody out", () => {
		let now = 0;
		const throttle = new AuthThrottle(3, 1000, () => now);
		for (let i = 0; i < 500; i++) {
			throttle.fail("10.0.0.1", "hdt_revoked");
			now += 1; // 500 tries within half the window
		}
		expect(throttle.blockedFor("10.0.0.1")).toBe(0);
		// ...and it still counts as one of the three
		throttle.fail("10.0.0.1", "guess-a");
		expect(throttle.blockedFor("10.0.0.1")).toBe(0);
		throttle.fail("10.0.0.1", "guess-b");
		expect(throttle.blockedFor("10.0.0.1")).toBeGreaterThan(0);
	});
	test("one noisy caller does not lock anybody else out", () => {
		const throttle = new AuthThrottle(2, 1000, () => 0);
		throttle.fail("10.0.0.1", "a");
		throttle.fail("10.0.0.1", "b");
		expect(throttle.blockedFor("10.0.0.1")).toBeGreaterThan(0);
		expect(throttle.blockedFor("10.0.0.2")).toBe(0);
	});
	test("loopback is never throttled: a proxy on this machine makes every visitor look local", () => {
		const throttle = new AuthThrottle(1, 1000, () => 0);
		for (const local of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"]) {
			expect(isLoopback(local)).toBe(true);
			throttle.fail(local, "a");
			throttle.fail(local, "b");
			expect(throttle.blockedFor(local)).toBe(0);
		}
		for (const remote of ["10.0.0.1", "100.64.0.1", "192.168.1.127", "::ffff:10.0.0.1", "2001:db8::1"]) expect(isLoopback(remote)).toBe(false);
	});
	test("the defaults allow a person's typos and stop a loop", () => {
		expect(AUTH_MAX_FAILURES).toBeGreaterThanOrEqual(10);
		expect(AUTH_FAILURE_WINDOW_MS).toBe(60_000);
	});
});

describe("wrong tokens over HTTP", () => {
	const TOKEN = "auth-throttle-test-token-0123456789";
	let app: App;
	let dir: string;
	const get = (from: string, token?: string, url = "/sessions") =>
		app.server.inject({ method: "GET", url, remoteAddress: from, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-throttle-"));
		const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: TOKEN, workspaceRoot: join(dir, "ws"), logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, extensionDirs: [] });
	});
	afterAll(async () => {
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("an address that keeps guessing is refused outright, the right token included", async () => {
		const from = "10.9.0.1";
		for (let i = 0; i < AUTH_MAX_FAILURES; i++) expect((await get(from, `wrong-${i}`)).statusCode).toBe(401);
		const blocked = await get(from, "wrong-again");
		expect(blocked.statusCode).toBe(429);
		expect(blocked.json().error.code).toBe("auth_throttled");
		expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
		expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(60);
		// a right guess must not get through either, or the limit would not limit anything
		expect((await get(from, TOKEN)).statusCode).toBe(429);
		// ...while everybody else is served
		expect((await get("10.9.0.2", TOKEN)).statusCode).toBe(200);
	});
	test("a device token and a stream ticket are guessed against the same limit", async () => {
		const from = "10.9.0.3";
		for (let i = 0; i < AUTH_MAX_FAILURES / 2; i++) {
			expect((await get(from, `hdt_made-up-${i}`)).statusCode).toBe(401);
			expect((await get(from, undefined, `/events?ticket=made-up-${i}`)).statusCode).toBe(401);
		}
		expect((await get(from, TOKEN)).statusCode).toBe(429);
	});
	test("one dead token asked over and over is one guess", async () => {
		const from = "10.9.0.6";
		for (let i = 0; i < AUTH_MAX_FAILURES * 3; i++) expect((await get(from, "hdt_revoked-device")).statusCode).toBe(401);
		expect((await get(from, TOKEN)).statusCode).toBe(200);
	});
	test("a request without any credential is refused but not counted as a guess", async () => {
		const from = "10.9.0.4";
		for (let i = 0; i < AUTH_MAX_FAILURES + 5; i++) expect((await get(from)).statusCode).toBe(401);
		expect((await get(from, TOKEN)).statusCode).toBe(200);
	});
	test("health and pairing stay reachable for a throttled address", async () => {
		const from = "10.9.0.5";
		for (let i = 0; i < AUTH_MAX_FAILURES; i++) await get(from, `wrong-${i}`);
		expect((await get(from, TOKEN)).statusCode).toBe(429);
		expect((await get(from, undefined, "/health")).statusCode).toBe(200);
		// the pairing code has its own limit (pairing.ts)
		const redeem = await app.server.inject({ method: "POST", url: "/pairing/redeem", remoteAddress: from, headers: { "content-type": "application/json" }, payload: { code: "not-a-real-code" } });
		expect(redeem.statusCode).toBe(403);
	});
	test("loopback is not throttled", async () => {
		for (let i = 0; i < AUTH_MAX_FAILURES + 5; i++) expect((await get("127.0.0.1", `wrong-${i}`)).statusCode).toBe(401);
		expect((await get("127.0.0.1", TOKEN)).statusCode).toBe(200);
	});
});
