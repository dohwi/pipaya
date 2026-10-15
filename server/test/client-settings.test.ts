import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { SERVER_SCOPED_KEYS } from "../src/client-settings.ts";

let app: App;
let dir: string;
const api = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { ...(auth ? { authorization: "Bearer test-token" } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "harness-client-settings-"));
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), defaultApproval: "ask", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

const events = () => app.bus.history({ after: 0, limit: 500 }).filter((e) => e.type === "client_settings_updated");

describe("client settings (server scoped)", () => {
	test("needs the token", async () => {
		expect((await api("GET", "/client-settings", undefined, false)).status).toBe(401);
	});

	test("only server-scoped keys are accepted: device preferences are refused", async () => {
		for (const key of ["theme", "keys", "volume", "servers", "token"]) {
			expect((await api("PUT", `/client-settings/${key}`, { value: 1 })).status).toBe(400);
		}
		expect(SERVER_SCOPED_KEYS).not.toContain("theme" as never);
	});

	test("empty until written; 404 for a single missing key", async () => {
		expect((await api("GET", "/client-settings")).json).toEqual({ settings: {} });
		expect((await api("GET", "/client-settings/favModels")).status).toBe(404);
	});

	test("save, read back and announce with the writer's origin", async () => {
		const put = await api("PUT", "/client-settings/favModels", { value: ["p\u0000m"], at: 1000, origin: "dev-a" });
		expect(put.status).toBe(200);
		expect(put.json).toEqual({ value: ["p\u0000m"], updatedAt: 1000, applied: true });
		expect((await api("GET", "/client-settings/favModels")).json).toEqual({ value: ["p\u0000m"], updatedAt: 1000 });
		const ev = events().at(-1)!;
		expect(ev.data).toEqual({ key: "favModels", updatedAt: 1000, origin: "dev-a" });
		expect(ev.sessionId).toBeNull();
	});

	test("last write wins: an older write is not applied and gets the stored value back", async () => {
		const before = events().length;
		const stale = await api("PUT", "/client-settings/favModels", { value: ["old"], at: 500 });
		expect(stale.json).toEqual({ value: ["p\u0000m"], updatedAt: 1000, applied: false });
		expect(events().length).toBe(before);
		const newer = await api("PUT", "/client-settings/favModels", { value: ["new"], at: 2000 });
		expect(newer.json.applied).toBe(true);
		const same = await api("PUT", "/client-settings/favModels", { value: ["new"], at: 2000 });
		expect(same.json.applied).toBe(true);
		expect((await api("GET", "/client-settings/favModels")).json.value).toEqual(["new"]);
	});

	test("a device clock in the future cannot pin a key", async () => {
		const res = await api("PUT", "/client-settings/extensions", { value: [], at: Date.now() + 10 * 24 * 3600_000 });
		expect(res.json.updatedAt).toBeLessThanOrEqual(Date.now());
		expect((await api("PUT", "/client-settings/extensions", { value: [1] })).json.applied).toBe(true);
	});

	test("list returns every stored key", async () => {
		const list = (await api("GET", "/client-settings")).json.settings;
		expect(Object.keys(list).sort()).toEqual(["extensions", "favModels"]);
	});

	test("the notification policy is checked, because the server acts on it", async () => {
		expect((await api("PUT", "/client-settings/notificationPolicy", { value: { escalateMinutes: 5 } })).status).toBe(200);
		for (const value of [{ escalateMinutes: 4 }, { escalateMinutes: "5" }, { escalateMinutes: -1 }, { escalateMinutes: 5, extra: 1 }, [], "5", null]) {
			expect((await api("PUT", "/client-settings/notificationPolicy", { value })).status).toBe(400);
		}
		expect((await api("GET", "/client-settings/notificationPolicy")).json.value).toEqual({ escalateMinutes: 5 });
	});

	test("oversized values are refused", async () => {
		expect((await api("PUT", "/client-settings/favModels", { value: "x".repeat(200_000) })).status).toBe(413);
		// extensions carry code, so they may be far larger than a favourites list
		expect((await api("PUT", "/client-settings/extensions", { value: "x".repeat(2_000_000) })).status).toBe(200);
	});
});
