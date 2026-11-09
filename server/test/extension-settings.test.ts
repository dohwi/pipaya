import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ExtensionSettings, isValidExtensionId, MAX_EXTENSIONS, MAX_SETTINGS_CHARS } from "../src/extension-settings.ts";

let app: App;
let dir: string;
const root = () => join(dir, "extensions");
const mode = (p: string) => statSync(p).mode & 0o777;
const api = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({
		method,
		url,
		headers: { ...(auth ? { authorization: "Bearer test-token" } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const rawPut = async (id: string, payload: string) => {
	const r = await app.server.inject({ method: "PUT", url: `/extensions/${id}/settings`, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, payload });
	return { status: r.statusCode, json: r.json() };
};
const entries = () => (existsSync(root()) ? readdirSync(root()) : []);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-ext-settings-"));
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("extension settings", () => {
	test("empty list before anything is saved", async () => {
		const res = await api("GET", "/extensions/settings");
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ settings: {} });
	});

	test("save / list roundtrip with 0600 file and 0700 dirs", async () => {
		const value = { theme: "dark", nested: { n: [1, 2, { a: null }] }, flag: true };
		const put = await api("PUT", "/extensions/my.ext/settings", { settings: value });
		expect(put.status).toBe(200);
		expect(put.json.value).toEqual(value);
		expect(put.json.applied).toBe(true);
		expect(typeof put.json.updatedAt).toBe("number");
		const other = await api("PUT", "/extensions/other-ext/settings", { settings: { x: 1 } });
		expect(other.status).toBe(200);

		const list = await api("GET", "/extensions/settings");
		expect(list.json.settings["my.ext"].value).toEqual(value);
		expect(list.json.settings["my.ext"].updatedAt).toBe(put.json.updatedAt);
		expect(list.json.settings["other-ext"].value).toEqual({ x: 1 });

		expect(mode(root())).toBe(0o700);
		expect(mode(join(root(), "my.ext"))).toBe(0o700);
		expect(mode(join(root(), "my.ext", "settings.json"))).toBe(0o600);
		expect(mode(join(root(), "my.ext", "settings.at"))).toBe(0o600);
		// atomic write leaves no temp files behind (the value and its timestamp only)
		expect(readdirSync(join(root(), "my.ext")).sort()).toEqual(["settings.at", "settings.json"]);

		const overwrite = await api("PUT", "/extensions/my.ext/settings", { settings: {} });
		expect(overwrite.json.value).toEqual({});
		expect((await api("GET", "/extensions/my.ext/settings")).json.value).toEqual({});
	});

	test("save publishes extension_settings_updated and the event is catalogued", async () => {
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => seen.push(e));
		await api("PUT", "/extensions/evt.test/settings", { settings: { a: 1 } });
		await api("DELETE", "/extensions/evt.test");
		off();
		expect(seen.map((e) => [e.type, e.sessionId, e.data])).toEqual([
			["extension_settings_updated", null, { id: "evt.test", action: "saved", updatedAt: expect.any(Number) }],
			["extension_settings_updated", null, { id: "evt.test", action: "deleted" }],
		]);
		const catalog = (await api("GET", "/events/types")).json.events;
		expect(catalog.some((e: any) => e.type === "extension_settings_updated")).toBe(true);
	});

	test("invalid ids are rejected without touching the filesystem", async () => {
		const fresh = mkdtempSync(join(tmpdir(), "pipaya-ext-ids-"));
		try {
			const store = new ExtensionSettings(fresh);
			const bad = ["../x", "A", "A.b", "a_b", "1a", "sync/x", "a/b.c", "..", ".", "a..b", "a.b.", ".a.b", "a_b.c", "1a.b", "a.b ", `a.${"b".repeat(80)}`, "a\\b.c", ""];
			for (const id of bad) {
				expect(() => store.save(id, { a: 1 })).toThrow();
				expect(() => store.get(id)).toThrow();
				expect(() => store.delete(id)).toThrow();
			}
			expect(existsSync(join(fresh, "extensions"))).toBe(false);
			expect(readdirSync(fresh)).toEqual([]);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	test("one-word ids such as `sync` are stored, like the client accepts them", async () => {
		for (const id of ["sync", "a"]) {
			const put = await api("PUT", `/extensions/${id}/settings`, { settings: { n: 1 } });
			expect(put.status).toBe(200);
			expect((await api("GET", "/extensions/settings")).json.settings[id].value).toEqual({ n: 1 });
			expect((await api("DELETE", `/extensions/${id}`)).status).toBe(200);
		}
	});

	test("server id rule matches the client manifest validator", () => {
		// Read the client's rule from its source (importing it would pull client code into the server's typecheck).
		const source = readFileSync(join(import.meta.dir, "..", "..", "client", "src", "lib", "extensions", "schema.ts"), "utf8");
		const match = /^const ID = \/(.+)\/;$/m.exec(source);
		expect(match).not.toBeNull();
		const clientId = new RegExp(match![1]!);
		const clientAccepts = (id: string) => id.length >= 1 && id.length <= 80 && clientId.test(id) && !["constructor", "prototype"].includes(id);
		const ids = ["sync", "a", "my.review", "team-session-tools", "a1", "a.b-c", "A", "1a", "a_b", "a..b", "a.", ".a", "a-", "a b", "ä", "constructor", "prototype", "", "x".repeat(80), "x".repeat(81)];
		for (const id of ids) expect([id.slice(0, 12), isValidExtensionId(id)]).toEqual([id.slice(0, 12), clientAccepts(id)]);
	});

	test("invalid ids over HTTP return 400 and create nothing", async () => {
		const before = entries();
		for (const id of ["A", "A.b", "a_b", "a%2Fb.c", "%2E%2E%2Fx", "..%2Fx", `a.${"b".repeat(80)}`, "a_b.c"]) {
			const put = await api("PUT", `/extensions/${id}/settings`, { settings: { a: 1 } });
			expect([400, 404]).toContain(put.status);
			if (put.status === 400) expect(put.json.error.code).toBe("invalid_request");
			const del = await api("DELETE", `/extensions/${id}`);
			expect([400, 404]).toContain(del.status);
		}
		expect((await api("DELETE", "/extensions/A.b")).status).toBe(400);
		expect(entries()).toEqual(before);
		// nothing escaped next to the data dir either
		expect(existsSync(join(dir, "x"))).toBe(false);
		expect(existsSync(join(dir, "settings.json"))).toBe(false);
	});

	test("traversal attempts never delete or write outside <dataDir>/extensions", async () => {
		const canary = join(dir, "canary");
		mkdirSync(canary);
		writeFileSync(join(canary, "keep.txt"), "x");
		for (const url of ["/extensions/..%2Fcanary", "/extensions/%2E%2E%2Fcanary", "/extensions/..", "/extensions/../canary"]) {
			const res = await app.server.inject({ method: "DELETE", url, headers: { authorization: "Bearer test-token" } });
			expect(res.statusCode).toBeGreaterThanOrEqual(400);
			expect(res.statusCode).toBeLessThan(500);
		}
		expect(existsSync(join(canary, "keep.txt"))).toBe(true);
		const store = new ExtensionSettings(dir);
		expect(() => store.delete("../canary")).toThrow();
		expect(() => store.save("../canary", {})).toThrow();
		expect(existsSync(join(canary, "keep.txt"))).toBe(true);
		expect(existsSync(join(canary, "settings.json"))).toBe(false);
	});

	test("corrupt, non-object and oversized files are treated as {} and never break the list", async () => {
		const cases: Record<string, string> = { "bad.json": "{not json", "arr.list": "[1,2]", "str.val": '"hi"', "nul.val": "null", "empty.file": "", "big.file": "{\"a\":\"" + "x".repeat(MAX_SETTINGS_CHARS * 5) + "\"}" };
		for (const [id, text] of Object.entries(cases)) {
			mkdirSync(join(root(), id), { recursive: true });
			writeFileSync(join(root(), id, "settings.json"), text);
		}
		mkdirSync(join(root(), "Not_Valid"), { recursive: true }); // invalid dir name: skipped
		writeFileSync(join(root(), "Not_Valid", "settings.json"), '{"a":1}');
		mkdirSync(join(root(), "no-file.here"), { recursive: true }); // no settings.json: skipped
		writeFileSync(join(root(), "stray.file"), "{}"); // plain file: skipped

		const res = await api("GET", "/extensions/settings");
		expect(res.status).toBe(200);
		for (const id of Object.keys(cases)) expect(res.json.settings[id].value).toEqual({});
		expect(res.json.settings["Not_Valid"]).toBeUndefined();
		expect(res.json.settings["no-file.here"]).toBeUndefined();
		expect(res.json.settings["stray.file"]).toBeUndefined();
		expect(res.json.settings["other-ext"].value).toEqual({ x: 1 });

		// a corrupt file can still be overwritten
		const fixed = await api("PUT", "/extensions/bad.json/settings", { settings: { ok: true } });
		expect(fixed.json.value).toEqual({ ok: true });
		for (const id of [...Object.keys(cases), "no-file.here"]) rmSync(join(root(), id), { recursive: true, force: true });
		rmSync(join(root(), "Not_Valid"), { recursive: true, force: true });
		rmSync(join(root(), "stray.file"), { force: true });
	});

	test("oversized settings are rejected and leave the old value intact", async () => {
		await api("PUT", "/extensions/size.test/settings", { settings: { keep: 1 } });
		const atLimit = { s: "x".repeat(MAX_SETTINGS_CHARS - JSON.stringify({ s: "" }).length) };
		expect(JSON.stringify(atLimit).length).toBe(MAX_SETTINGS_CHARS);
		expect((await api("PUT", "/extensions/size.test/settings", { settings: atLimit })).status).toBe(200);
		await api("PUT", "/extensions/size.test/settings", { settings: { keep: 1 } });

		const over = await api("PUT", "/extensions/size.test/settings", { settings: { s: "x".repeat(MAX_SETTINGS_CHARS) } });
		expect(over.status).toBe(413);
		expect(over.json.error.code).toBe("payload_too_large");
		expect((await api("GET", "/extensions/settings")).json.settings["size.test"].value).toEqual({ keep: 1 });
		await api("DELETE", "/extensions/size.test");
	});

	test("non-object bodies are rejected", async () => {
		const before = entries();
		for (const raw of ['{"settings":[1]}', '{"settings":"x"}', '{"settings":null}', '{"settings":1}', "{}", "[]", '"x"', "null", '{"settings":true}']) {
			const res = await rawPut("body.test", raw);
			expect(res.status).toBe(400);
			expect(res.json.error.code).toBe("invalid_request");
		}
		expect(entries()).toEqual(before);
		const store = new ExtensionSettings(dir);
		for (const v of [[], "x", null, 1, undefined]) expect(() => store.save("body.test", v)).toThrow();
		expect(entries()).toEqual(before);
	});

	test("delete removes the settings (and the folder when nothing else is in it) and is idempotent", async () => {
		await api("PUT", "/extensions/del.test/settings", { settings: { a: 1 } });
		expect(await api("DELETE", "/extensions/del.test")).toEqual({ status: 200, json: { ok: true } });
		expect(existsSync(join(root(), "del.test"))).toBe(false);
		// a server extension installed under the same id keeps its code
		await api("PUT", "/extensions/del.test/settings", { settings: { a: 1 } });
		writeFileSync(join(root(), "del.test", "index.ts"), "x");
		expect(await api("DELETE", "/extensions/del.test")).toEqual({ status: 200, json: { ok: true } });
		expect(readdirSync(join(root(), "del.test"))).toEqual(["index.ts"]);
		rmSync(join(root(), "del.test"), { recursive: true, force: true });
		expect(await api("DELETE", "/extensions/del.test")).toEqual({ status: 200, json: { ok: true } });
		expect((await api("GET", "/extensions/settings")).json.settings["del.test"]).toBeUndefined();
	});

	test("at most 100 extension folders can be created; existing ones can still be updated", () => {
		const fresh = mkdtempSync(join(tmpdir(), "pipaya-ext-cap-"));
		try {
			const store = new ExtensionSettings(fresh);
			for (let i = 0; i < MAX_EXTENSIONS; i++) store.save(`ext.n${i}`, { i });
			expect(() => store.save("ext.extra", {})).toThrow();
			expect(existsSync(join(fresh, "extensions", "ext.extra"))).toBe(false);
			expect(store.save("ext.n3", { i: "again" }).value).toEqual({ i: "again" });
			store.delete("ext.n0");
			expect(store.save("ext.extra", {}).value).toEqual({});
			expect(Object.keys(store.list())).toHaveLength(MAX_EXTENSIONS);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	test("a write older than the stored value is refused and the newer one is returned", async () => {
		const t0 = Date.now() - 60_000;
		const first = await api("PUT", "/extensions/lww.test/settings", { settings: { v: "new" }, at: t0 + 1000 });
		expect(first.json.applied).toBe(true);
		expect(first.json.updatedAt).toBe(t0 + 1000);

		// an offline edit made before the stored one loses, and the caller learns the winner
		const stale = await api("PUT", "/extensions/lww.test/settings", { settings: { v: "old" }, at: t0 });
		expect(stale.json).toEqual({ value: { v: "new" }, updatedAt: t0 + 1000, applied: false });
		expect((await api("GET", "/extensions/lww.test/settings")).json.value).toEqual({ v: "new" });

		// equal times: the incoming write wins, so a resend is harmless
		const same = await api("PUT", "/extensions/lww.test/settings", { settings: { v: "again" }, at: t0 + 1000 });
		expect(same.json).toEqual({ value: { v: "again" }, updatedAt: t0 + 1000, applied: true });

		// a device clock in the future cannot pin the value
		const future = await api("PUT", "/extensions/lww.test/settings", { settings: { v: "future" }, at: Date.now() + 86_400_000 });
		expect(future.json.updatedAt).toBeLessThanOrEqual(Date.now() + 1000);
		expect((await api("PUT", "/extensions/lww.test/settings", { settings: { v: "now" } })).json.applied).toBe(true);
		await api("DELETE", "/extensions/lww.test");
	});

	test("a refused write publishes nothing, so other devices do not refetch", async () => {
		const t0 = Date.now() - 60_000;
		await api("PUT", "/extensions/quiet.test/settings", { settings: { v: 2 }, at: t0 + 1000 });
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.type === "extension_settings_updated") seen.push(e.data); });
		await api("PUT", "/extensions/quiet.test/settings", { settings: { v: 1 }, at: t0 });
		off();
		expect(seen).toEqual([]);
		await api("DELETE", "/extensions/quiet.test");
	});

	test("the writing device is echoed in the event so it can skip its own change", async () => {
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.type === "extension_settings_updated") seen.push(e.data); });
		await api("PUT", "/extensions/origin.test/settings", { settings: { a: 1 }, origin: "device-a" });
		off();
		expect(seen).toEqual([{ id: "origin.test", action: "saved", updatedAt: expect.any(Number), origin: "device-a" }]);
		await api("DELETE", "/extensions/origin.test");
	});

	test("one extension's settings can be read on their own", async () => {
		expect((await api("GET", "/extensions/missing.settings/settings")).status).toBe(404);
		const put = await api("PUT", "/extensions/one.test/settings", { settings: { a: 1 } });
		const one = await api("GET", "/extensions/one.test/settings");
		expect(one.status).toBe(200);
		expect(one.json).toEqual({ value: { a: 1 }, updatedAt: put.json.updatedAt });
		await api("DELETE", "/extensions/one.test");
		expect((await api("GET", "/extensions/one.test/settings")).status).toBe(404);
	});

	test("a settings file from before timestamps keeps its mtime as the time of its value", async () => {
		const store = new ExtensionSettings(dir);
		const folder = join(root(), "legacy.one");
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "settings.json"), '{"old":true}');
		const before = Date.now() - 3_600_000;
		utimesSync(join(folder, "settings.json"), new Date(before), new Date(before));

		const stored = store.getStored("legacy.one")!;
		expect(stored.value).toEqual({ old: true });
		expect(Math.abs(stored.updatedAt - before)).toBeLessThan(2000);
		// an edit made now is newer than the migrated value
		expect(store.save("legacy.one", { fresh: true }).applied).toBe(true);
		// and an edit claimed to be older than the file is refused
		writeFileSync(join(folder, "settings.json"), '{"old":true}');
		rmSync(join(folder, "settings.at"), { force: true });
		utimesSync(join(folder, "settings.json"), new Date(before), new Date(before));
		expect(store.save("legacy.one", { stale: true }, before - 1000).applied).toBe(false);
		store.delete("legacy.one");
	});

	test("authentication is required on every route", async () => {
		const calls: [string, string, unknown?][] = [
			["GET", "/extensions/settings"],
			["GET", "/extensions/auth.test/settings"],
			["PUT", "/extensions/auth.test/settings", { settings: { a: 1 } }],
			["DELETE", "/extensions/auth.test"],
		];
		for (const [method, url, body] of calls) {
			expect((await api(method, url, body, false)).status).toBe(401);
			const wrong = await app.server.inject({ method: method as any, url, headers: { authorization: "Bearer nope" } });
			expect(wrong.statusCode).toBe(401);
		}
		expect(existsSync(join(root(), "auth.test"))).toBe(false);
	});
});
