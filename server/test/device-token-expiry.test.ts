import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { DEFAULT_DEVICE_TOKEN_IDLE_DAYS, DeviceTokens } from "../src/device-tokens.ts";

const DAY = 24 * 3600_000;
let dir: string;
let db: Database;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-device-expiry-"));
	db = openDb(join(dir, "db.sqlite"));
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("a paired device that stops connecting", () => {
	test("loses its access after the idle time, counted from its last use", () => {
		let now = 1_000_000;
		const devices = new DeviceTokens(db, () => now, 30);
		const { id, token } = devices.issue("Phone");
		now += 29 * DAY;
		expect(devices.verify(token)).toBe(id); // used on day 29: the count starts over
		now += 29 * DAY;
		expect(devices.verify(token)).toBe(id);
		now += 30 * DAY;
		expect(devices.verify(token)).toBeNull();
		// gone for good, not only refused this once
		now -= 30 * DAY;
		expect(devices.verify(token)).toBeNull();
		expect(devices.has(id)).toBe(false);
	});
	test("a device that was paired and never connected expires from its pairing", () => {
		let now = 0;
		const devices = new DeviceTokens(db, () => now, 30);
		const { token } = devices.issue("Never used");
		now = 30 * DAY - 1;
		expect(devices.list().length).toBe(1);
		now = 30 * DAY;
		expect(devices.list()).toEqual([]); // the list does not show a device that can no longer get in
		expect(devices.verify(token)).toBeNull();
	});
	test("only the idle device goes; its open connections are hung up", () => {
		let now = 0;
		const devices = new DeviceTokens(db, () => now, 30);
		const idle = devices.issue("Idle");
		const busy = devices.issue("Busy");
		let closed = 0;
		const socket = { destroy: () => void closed++, once: () => {} } as unknown as import("node:net").Socket;
		devices.track(idle.id, socket);
		now = 20 * DAY;
		expect(devices.verify(busy.token)).toBe(busy.id);
		now = 31 * DAY;
		expect(devices.list().map((d) => d.name)).toEqual(["Busy"]);
		expect(closed).toBe(1);
		expect(devices.verify(busy.token)).toBe(busy.id);
	});
	test("0 keeps a device for ever", () => {
		let now = 0;
		const devices = new DeviceTokens(db, () => now, 0);
		const { id, token } = devices.issue("Old tablet");
		now = 5000 * DAY;
		expect(devices.list().length).toBe(1);
		expect(devices.verify(token)).toBe(id);
	});
	test("the setting: 90 days unless PIPAYA_DEVICE_TOKEN_IDLE_DAYS says otherwise", () => {
		const env = { PIPAYA_DATA_DIR: dir, PIPAYA_TOKEN: "device-expiry-test-token-0123456789" };
		expect(DEFAULT_DEVICE_TOKEN_IDLE_DAYS).toBe(90);
		expect(loadConfig(env).deviceTokenIdleDays).toBe(DEFAULT_DEVICE_TOKEN_IDLE_DAYS);
		expect(loadConfig({ ...env, PIPAYA_DEVICE_TOKEN_IDLE_DAYS: "7" }).deviceTokenIdleDays).toBe(7);
		expect(loadConfig({ ...env, PIPAYA_DEVICE_TOKEN_IDLE_DAYS: "0" }).deviceTokenIdleDays).toBe(0);
		expect(loadConfig({ ...env, PIPAYA_DEVICE_TOKEN_IDLE_DAYS: "-3" }).deviceTokenIdleDays).toBe(0);
		expect(loadConfig({ ...env, PIPAYA_DEVICE_TOKEN_IDLE_DAYS: "soon" }).deviceTokenIdleDays).toBe(DEFAULT_DEVICE_TOKEN_IDLE_DAYS);
	});
});
