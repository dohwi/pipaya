import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { LocaleStore, MAX_LOCALES, MAX_LOCALE_MESSAGES, normalizeLocaleTag } from "../src/locales.ts";

let app: App;
let dir: string;
const root = () => join(dir, "locales");
const api = async (method: any, url: string, payload?: unknown, auth = true) => {
	const r = await app.server.inject({
		method, url,
		headers: { ...(auth ? { authorization: "Bearer test-token" } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
		...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
	});
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const ja = { name: "日本語", messages: { "설정": "設定", "모델 {n}개": "{n}個のモデル" } };

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "harness-locales-"));
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), defaultApproval: "ask", approvalTimeoutMs: 1000, logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("locale packs", () => {
	test("requires the token", async () => {
		expect((await api("GET", "/locales", undefined, false)).status).toBe(401);
		expect((await api("PUT", "/locales/ja", ja, false)).status).toBe(401);
	});

	test("empty before anything is saved, and an unknown pack is 404", async () => {
		expect((await api("GET", "/locales")).json).toEqual({ locales: [] });
		expect((await api("GET", "/locales/ja")).status).toBe(404);
	});

	test("save / list / get roundtrip, with the tag lower-cased and a private 0600 file", async () => {
		const put = await api("PUT", "/locales/PT-BR", { name: "Português", messages: { "설정": "Configurações" }, owner: "lang.pt" });
		expect(put.status).toBe(200);
		expect(put.json).toMatchObject({ tag: "pt-br", name: "Português", owner: "lang.pt", messages: { "설정": "Configurações" } });
		expect(put.json.updatedAt).toBeGreaterThan(0);
		expect((await api("PUT", "/locales/ja", ja)).status).toBe(200);
		const list = (await api("GET", "/locales")).json.locales;
		expect(list.map((l: any) => l.tag)).toEqual(["ja", "pt-br"]);
		expect(list[0]).toMatchObject({ tag: "ja", name: "日本語", messages: 2 });
		expect(list[0].owner).toBeUndefined();
		expect(list[0].messages).toBe(2);
		expect((await api("GET", "/locales/pt-BR")).json.messages).toEqual({ "설정": "Configurações" });
		expect(statSync(join(root(), "ja.json")).mode & 0o777).toBe(0o600);
		expect(statSync(root()).mode & 0o777).toBe(0o700);
		expect(readdirSync(root()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("saving again replaces the pack and bumps updatedAt", async () => {
		const before = (await api("GET", "/locales/ja")).json.updatedAt;
		await new Promise((r) => setTimeout(r, 5));
		const put = await api("PUT", "/locales/ja", { name: "日本語", messages: { "설정": "設定です" } });
		expect(put.json.messages).toEqual({ "설정": "設定です" });
		expect(put.json.updatedAt).toBeGreaterThan(before);
	});

	test("saving identical content is a no-op: same updatedAt, no event", async () => {
		const body = { name: "Italiano", messages: { "설정": "Impostazioni" }, owner: "lang.it" };
		const first = (await api("PUT", "/locales/it", body)).json;
		const mark = (await api("GET", "/events/history?limit=1")).json.latestId;
		await new Promise((r) => setTimeout(r, 5));
		const again = (await api("PUT", "/locales/it", body)).json;
		expect(again.updatedAt).toBe(first.updatedAt);
		expect((await api("GET", `/events/history?after=${mark}&limit=20`)).json.events.filter((e: any) => e.type === "locales_updated")).toEqual([]);
		const changed = (await api("PUT", "/locales/it", { ...body, messages: { "설정": "Impostazioni!" } })).json;
		expect(changed.updatedAt).toBeGreaterThan(first.updatedAt);
	});

	test("an extension's pack is protected from other extensions and from owner-scoped deletes", async () => {
		expect((await api("PUT", "/locales/it", { name: "Italiano", messages: { a: "b" }, owner: "lang.other" })).status).toBe(409);
		expect((await api("PUT", "/locales/it", { name: "Italiano", messages: { a: "b" } })).status).toBe(200); // manual replace by an admin
		await api("PUT", "/locales/it", { name: "Italiano", messages: { a: "b" }, owner: "lang.it" });
		expect((await api("DELETE", "/locales/it?owner=lang.other")).json).toEqual({ ok: true });
		expect((await api("GET", "/locales/it")).status).toBe(200); // not the owner: untouched
		await api("DELETE", "/locales/it?owner=lang.it");
		expect((await api("GET", "/locales/it")).status).toBe(404);
	});

	test("built-in languages are reserved", async () => {
		expect((await api("PUT", "/locales/ko", ja)).status).toBe(409);
		expect((await api("PUT", "/locales/EN", ja)).status).toBe(409);
		expect(existsSync(join(root(), "en.json"))).toBe(false);
	});

	test("rejects bad tags, names, messages and owners", async () => {
		for (const tag of ["j", "ja_JP", "..", "a.b", "ja-", "toolonglanguage-x"]) {
			const r = await api("PUT", `/locales/${tag}`, ja);
			expect([400, 404], tag).toContain(r.status);
		}
		expect((await api("PUT", "/locales/de", { name: "", messages: { a: "b" } })).status).toBe(400);
		expect((await api("PUT", "/locales/de", { name: "Deutsch", messages: {} })).status).toBe(400);
		expect((await api("PUT", "/locales/de", { name: "Deutsch", messages: { a: "" } })).status).toBe(400);
		expect((await api("PUT", "/locales/de", { name: "Deutsch", messages: { a: 1 } })).status).toBe(400);
		expect((await api("PUT", "/locales/de", { name: "Deutsch", messages: { a: "b" }, owner: "Bad Id" })).status).toBe(400);
		expect((await api("PUT", "/locales/de", { name: "Deutsch", messages: { a: "b" }, extra: 1 })).status).toBe(400);
		expect((await api("GET", "/locales/de")).status).toBe(404);
	});

	test("rejects a prototype-polluting key", async () => {
		const r = await app.server.inject({ method: "PUT", url: "/locales/de", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, payload: '{"name":"Deutsch","messages":{"__proto__":"x"}}' });
		expect(r.statusCode).toBe(400);
		expect(({} as any).x).toBeUndefined();
	});

	test("enforces the message and pack limits", async () => {
		const many = Object.fromEntries(Array.from({ length: MAX_LOCALE_MESSAGES + 1 }, (_, i) => [`k${i}`, "v"]));
		expect((await api("PUT", "/locales/de", { name: "Deutsch", messages: many })).status).toBe(413);
		const store = new LocaleStore(mkdtempSync(join(tmpdir(), "harness-locales-limit-")));
		for (let i = 0; i < MAX_LOCALES; i++) store.save(`x${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, { name: "n", messages: { a: "b" } });
		expect(() => store.save("zz", { name: "n", messages: { a: "b" } })).toThrow(/at most/);
		expect(() => store.save("xaa", { name: "n2", messages: { a: "b" } })).not.toThrow(); // replacing is allowed at the cap
		rmSync(store.root, { recursive: true, force: true });
		rmSync(join(store.root, ".."), { recursive: true, force: true });
	});

	test("a corrupt file reads as absent and does not break the list", async () => {
		mkdirSync(root(), { recursive: true });
		writeFileSync(join(root(), "fr.json"), "{not json");
		writeFileSync(join(root(), "notes.txt"), "x");
		expect((await api("GET", "/locales/fr")).status).toBe(404);
		expect((await api("GET", "/locales")).json.locales.map((l: any) => l.tag)).toEqual(["ja", "pt-br"]);
	});

	test("save and delete publish locales_updated, and the event is catalogued", async () => {
		const before = (await api("GET", "/events/history?limit=1")).json.latestId;
		await api("PUT", "/locales/es", { name: "Español", messages: { a: "b" } });
		await api("DELETE", "/locales/es");
		await api("DELETE", "/locales/es"); // idempotent, no second event
		const events = (await api("GET", `/events/history?after=${before}&limit=50`)).json.events.filter((e: any) => e.type === "locales_updated");
		expect(events.map((e: any) => [e.sessionId, e.data.tag, e.data.action])).toEqual([[null, "es", "saved"], [null, "es", "deleted"]]);
		expect((await api("GET", "/events/types")).json.events.some((e: any) => e.type === "locales_updated")).toBe(true);
	});

	test("delete removes the pack", async () => {
		expect((await api("DELETE", "/locales/ja")).json).toEqual({ ok: true });
		expect((await api("GET", "/locales/ja")).status).toBe(404);
	});

	test("normalizeLocaleTag", () => {
		expect(normalizeLocaleTag("Zh-Hant-TW")).toBe("zh-hant-tw");
		expect(() => normalizeLocaleTag("x")).toThrow();
		expect(() => normalizeLocaleTag(undefined)).toThrow();
	});
});
