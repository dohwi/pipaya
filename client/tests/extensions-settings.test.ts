import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { fillSettingDefaults, parsePackage, resolveSettings, type SettingField } from "../src/lib/extensions/schema";
import type { ExtensionHost as ExtensionHostType, ExtensionContext, HostAdapter } from "../src/lib/extensions/host.svelte";

// ---------------------------------------------------------------- pure schema
const base = { manifest: { id: "example.cfg", name: "Cfg", version: "1.0.0", sdkVersion: 1, permissions: [] as string[] }, code: "export default {};" };
const withSettings = (settings: unknown, permissions: string[] = []) => ({ ...base, manifest: { ...base.manifest, permissions, settings } });
const field = (extra: Record<string, unknown> = {}) => ({ key: "name", type: "string", label: "Name", ...extra });

describe("manifest settings schema", () => {
	test("generic local scope and secret fields validate without vendor-specific config", () => {
		const input = { ...base, manifest: { ...base.manifest, settingsScope: "local", settings: [field({ key: "httpToken", secret: true, required: true })] } };
		expect(parsePackage(input).manifest.settingsScope).toBe("local");
		expect(parsePackage(input).manifest.settings![0]!.secret).toBe(true);
		expect(() => parsePackage({ ...input, manifest: { ...input.manifest, settingsScope: "cloud" } })).toThrow();
		expect(() => parsePackage(withSettings([field({ secret: true, default: "secret" })]))).toThrow();
		expect(() => parsePackage(withSettings([field({ type: "number", secret: true })]))).toThrow();
	});
	test("accepts every field type and round-trips as fresh data", () => {
		const input = withSettings([
			field({ key: "origin", label: "서버", format: "origin", required: true, placeholder: "https://x.test", description: "설명", default: "https://a.test" }),
			{ key: "interval", type: "number", label: "간격", min: 10, max: 60, default: 30 },
			{ key: "on", type: "boolean", label: "켜기", default: true },
			{ key: "mode", type: "select", label: "모드", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "b" },
		]);
		const parsed = parsePackage(input);
		expect(parsed.manifest.settings).toHaveLength(4);
		expect(parsed.manifest.settings![0]!.format).toBe("origin");
		expect(parsed.manifest.settings).not.toBe(input.manifest.settings);
		expect(parsePackage(base).manifest.settings).toBeUndefined();
	});
	test("rejects bad keys, duplicates, unknown fields and more than 20 fields", () => {
		for (const key of ["1a", "a-b", "", "a".repeat(41), "한글", "a b"]) expect(() => parsePackage(withSettings([field({ key })])), key).toThrow();
		expect(() => parsePackage(withSettings([field(), field()]))).toThrow("duplicate setting key");
		expect(() => parsePackage(withSettings([field({ extra: 1 })]))).toThrow("unknown field");
		expect(() => parsePackage(withSettings("x"))).toThrow();
		const many = Array.from({ length: 21 }, (_, i) => field({ key: `k${i}` }));
		expect(() => parsePackage(withSettings(many))).toThrow("at most 20");
		expect(parsePackage(withSettings(many.slice(0, 20))).manifest.settings).toHaveLength(20);
	});
	test("rejects default/type mismatches and invalid constraints", () => {
		const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
		const bad: Record<string, unknown>[] = [
			field({ default: 1 }),
			field({ type: "number", default: "1" }),
			field({ type: "number", default: Number.NaN }),
			field({ type: "number", min: 5, default: 1 }),
			field({ type: "number", min: 5, max: 1 }),
			field({ type: "boolean", default: "true" }),
			field({ type: "select", options, default: "c" }),
			field({ type: "select", options: [options[0]] }),
			field({ type: "select" }),
			field({ type: "select", options: [options[0], options[0]] }),
			field({ type: "select", options: Array.from({ length: 21 }, (_, i) => ({ value: `v${i}`, label: "x" })) }),
			field({ type: "date" }),
			field({ label: "x".repeat(61) }),
			field({ description: "x".repeat(201) }),
			field({ placeholder: "x".repeat(81) }),
			field({ required: "yes" }),
			field({ format: "email" }),
			field({ type: "number", format: "origin" }),
			field({ min: 1 }),
			field({ options }),
			field({ format: "origin", default: "https://a.test/path" }),
		];
		bad.forEach((f, i) => expect(() => parsePackage(withSettings([f])), `case ${i}`).toThrow());
	});
});

describe("resolveSettings", () => {
	const fields = parsePackage(withSettings([
		field({ key: "origin", label: "서버", format: "origin", required: true }),
		{ key: "interval", type: "number", label: "간격", min: 10, max: 60, default: 30 },
		{ key: "on", type: "boolean", label: "켜기", default: false },
		{ key: "mode", type: "select", label: "모드", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a" },
		field({ key: "note", label: "메모" }),
	])).manifest.settings as SettingField[];

	test("applies defaults, drops unknown keys, leaves optional unset values out", () => {
		const r = resolveSettings(fields, { origin: "https://a.test", extra: 1, __proto__x: 2 });
		expect(r).toEqual({ values: { origin: "https://a.test", interval: 30, on: false, mode: "a" }, errors: {}, ok: true });
	});
	test("required fields: missing, null and blank strings are errors", () => {
		for (const raw of [{}, { origin: "" }, { origin: "   " }, { origin: null }, null, "x", []]) {
			const r = resolveSettings(fields, raw);
			expect(r.ok).toBe(false);
			expect(r.errors.origin).toBe("필수 항목입니다");
			expect(r.values.interval).toBe(30);
		}
	});
	test("strict types: no silent coercion", () => {
		const r = resolveSettings(fields, { origin: 5, interval: "20", on: "true", mode: 1, note: 3 });
		expect(r.ok).toBe(false);
		expect(Object.keys(r.errors).sort()).toEqual(["interval", "mode", "note", "on", "origin"]);
		expect(r.values).toEqual({});
		expect(resolveSettings(fields, { origin: "https://a.test", interval: Number.NaN }).errors.interval).toBe("숫자여야 합니다");
		expect(resolveSettings(fields, { origin: "https://a.test", interval: Infinity }).errors.interval).toBeTruthy();
	});
	test("origin format reuses the http origin rules", () => {
		const ok = ["https://a.test", "http://localhost:8080", "https://a.test/"];
		for (const origin of ok) expect(resolveSettings(fields, { origin }).errors.origin, origin).toBeUndefined();
		for (const origin of ["ftp://a.test", "https://a.test/path", "https://a.test?x=1", "https://u:p@a.test", "a.test", "javascript:alert(1)"]) {
			expect(resolveSettings(fields, { origin }).errors.origin, origin).toBe("올바른 주소(origin)가 아닙니다");
		}
	});
	test("number bounds and select membership", () => {
		const o = { origin: "https://a.test" };
		expect(resolveSettings(fields, { ...o, interval: 9 }).errors.interval).toBe("최소 10 이상");
		expect(resolveSettings(fields, { ...o, interval: 61 }).errors.interval).toBe("최대 60 이하");
		expect(resolveSettings(fields, { ...o, interval: 10 }).ok).toBe(true);
		expect(resolveSettings(fields, { ...o, interval: 60 }).ok).toBe(true);
		expect(resolveSettings(fields, { ...o, mode: "z" }).errors.mode).toBe("선택할 수 없는 값입니다");
		expect(resolveSettings(fields, { ...o, mode: "b" }).values.mode).toBe("b");
	});
	test("does not mutate input; fillSettingDefaults keeps existing and unknown values", () => {
		const raw = { origin: "https://a.test", keep: { x: 1 } };
		const copy = JSON.stringify(raw);
		resolveSettings(fields, raw);
		expect(JSON.stringify(raw)).toBe(copy);
		expect(fillSettingDefaults(fields, raw)).toEqual({ origin: "https://a.test", keep: { x: 1 }, interval: 30, on: false, mode: "a" });
		expect(fillSettingDefaults(fields, { interval: 12 }).interval).toBe(12);
	});
});

// ---------------------------------------------------------------- host
const FAKE_RUNTIME = `
const created = (globalThis.__fakeRuntimes ??= []);
export class ExtensionRuntime {
	stopped = false; pkg = null;
	constructor(callbacks) { this.callbacks = callbacks; created.push(this); }
	async start(pkg) { this.pkg = pkg; await globalThis.__fakeRuntimeStart?.(this); }
	execute() { return Promise.resolve(); }
	event() {}
	stop() { this.stopped = true; }
}
`;
let ExtensionHost: new () => ExtensionHostType;
let i18nModule: typeof import("../src/lib/i18n");
let dir: string;
const storage = new Map<string, string>();
const loc = { search: "" };
function defineGlobal(name: string, value: unknown) { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
defineGlobal("localStorage", {
	getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
	setItem: (k: string, v: string) => { storage.set(k, String(v)); },
	removeItem: (k: string) => { storage.delete(k); },
	clear: () => storage.clear(),
});
defineGlobal("location", loc);
defineGlobal("document", { documentElement: { style: { setProperty() {}, removeProperty: () => "" } } });
const realFetch = globalThis.fetch;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-extensions-settings-"));
	const fakeFile = join(dir, "fake-runtime.js");
	await writeFile(fakeFile, FAKE_RUNTIME);
	// Host and i18n go into one bundle, so the tests and the host share a single i18n instance.
	const entry = join(dir, "entry.ts");
	await writeFile(entry, `export { ExtensionHost } from ${JSON.stringify(resolve("src/lib/extensions/host.svelte.ts"))};\nexport * from ${JSON.stringify(resolve("src/lib/i18n.ts"))};\n`);
	const build = await Bun.build({
		entrypoints: [entry], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /^\.\/runtime$/ }, () => ({ path: fakeFile }));
			builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
				return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "host.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	const bundle = await import(file);
	ExtensionHost = bundle.ExtensionHost;
	i18nModule = bundle;
});
afterAll(async () => { globalThis.fetch = realFetch; if (dir) await rm(dir, { recursive: true, force: true }); });

interface Req { method: string; path: string; body?: any; auth: string | null }
let requests: Req[] = [];
let respond: (req: Req) => Response | Promise<Response> = () => new Response("{}", { status: 200 });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
	storage.clear(); loc.search = ""; requests = [];
	((globalThis as any).__fakeRuntimes ??= []).length = 0; delete (globalThis as any).__fakeRuntimeStart;
	respond = () => json({ settings: {} });
	globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		const req: Req = { method: init.method ?? "GET", path: String(url).replace("http://srv.test", ""), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") };
		requests.push(req);
		return respond(req);
	}) as typeof fetch;
});

const CONTEXT: ExtensionContext = { sessionId: "s1", model: "m", provider: "p", running: false, online: true };
const CONN = { baseUrl: "http://srv.test", token: "tok" };
function makeAdapter(connection: HostAdapter["connection"] = () => CONN) {
	const notices: string[] = [];
	const adapter: HostAdapter = { prefill() {}, notify: t => { notices.push(t); }, context: () => ({ ...CONTEXT }), dark: () => true, reservedCommands: () => [], connection };
	return { adapter, notices };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => setTimeout(r, 0)); };
async function boot(connection?: HostAdapter["connection"]) {
	const host = new ExtensionHost();
	const a = makeAdapter(connection);
	host.init(a.adapter);
	await flush();
	return { host, ...a };
}
const SCHEMA = [
	{ key: "httpOrigin", type: "string", label: "서버 주소", format: "origin", required: true },
	{ key: "interval", type: "number", label: "간격", min: 10, default: 30 },
];
const cfg = (id = "example.cfg", settings: unknown = SCHEMA, permissions = ["http"]) =>
	({ manifest: { id, name: id, version: "1.0.0", sdkVersion: 1, permissions, ...(settings === null ? {} : { settings }) }, code: "/* x */" });
const seed = (entries: { package: unknown; enabled?: boolean; settings?: unknown }[]) =>
	storage.set("pipaya.extensions.v1", JSON.stringify(entries.map(e => ({ enabled: false, settings: {}, ...e }))));
const request = (host: ExtensionHostType, id: string, method: string, args: unknown[] = []) =>
	(host as unknown as { request(id: string, m: string, a: unknown[], r: unknown): any }).request(id, method, args, {});

describe("settings gating, defaults and sdk semantics", () => {
	test("enable is refused with a Korean reason while required settings are missing; state stays disabled", async () => {
		seed([{ package: parsePackage(cfg()), settings: {} }]); // stored by an earlier version: already "configured"
		const { host } = await boot(() => null);
		const id = "example.cfg";
		await expect(host.enable(id)).rejects.toThrow("필수 설정을 확인하세요");
		await expect(host.enable(id)).rejects.toThrow("서버 주소: 필수 항목입니다");
		expect(host.find(id).state).toBe("disabled");
		expect(host.find(id).enabled).toBe(false);
		expect(host.settingsProblem(id)).toContain("서버 주소");
		await host.setSettings(id, { httpOrigin: "https://a.test" });
		expect(host.settingsProblem(id)).toBe("");
		await host.enable(id);
		expect(host.find(id).state).toBe("active");
	});
	test("a boot-time enabled extension with invalid settings stays disabled and is not started", async () => {
		seed([{ package: parsePackage(cfg()), enabled: true, settings: {} }]);
		const { host } = await boot(() => null);
		expect(host.installed[0]!.state).toBe("disabled");
		expect(host.installed[0]!.enabled).toBe(false);
		expect(host.installed[0]!.error).toContain("필수 설정");
		expect(((globalThis as any).__fakeRuntimes as unknown[]).length).toBe(0);
	});
	test("setSettings validates against the schema and keeps the old value on error", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg());
		await host.setSettings(id, { httpOrigin: "https://a.test", ignored: 1 });
		expect(host.find(id).settings).toEqual({ httpOrigin: "https://a.test", interval: 30 });
		expect(() => host.setSettings(id, { httpOrigin: "nope" })).toThrow("올바른 주소(origin)가 아닙니다");
		expect(() => host.setSettings(id, { httpOrigin: "https://a.test", interval: 5 })).toThrow("최소 10 이상");
		expect(host.find(id).settings.httpOrigin).toBe("https://a.test");
	});
	test("install fills defaults immediately; reinstall keeps values and fills new defaults", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg());
		expect(host.find(id).settings).toEqual({ interval: 30 });
		await host.setSettings(id, { httpOrigin: "https://a.test", interval: 15 });
		host.install(cfg("example.cfg", [...SCHEMA, { key: "on", type: "boolean", label: "x", default: true }]));
		expect(host.find(id).settings).toEqual({ httpOrigin: "https://a.test", interval: 15, on: true });
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)[0].settings.interval).toBe(15);
	});
	test("sdk settings.get returns resolved values; extensions without schema get the raw object", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg());
		await host.setSettings(id, { httpOrigin: "https://a.test" });
		host.find(id).settings = { httpOrigin: "https://a.test", stray: 1 }; // legacy value stored before the schema existed
		expect(request(host, id, "settings.get")).toEqual({ httpOrigin: "https://a.test", interval: 30 });
		const plain = host.install(cfg("example.plain", null));
		await host.setSettings(plain, { anything: [1, { a: 2 }] });
		expect(request(host, plain, "settings.get")).toEqual({ anything: [1, { a: 2 }] });
	});
	test("http.getJson reads its origin from the resolved settings", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg());
		await host.setSettings(id, { httpOrigin: "https://a.test/" });
		const seen: string[] = [];
		globalThis.fetch = (async (url: string) => { seen.push(String(url)); return json({ ok: true }); }) as typeof fetch;
		await host.enable(id);
		expect(await request(host, id, "http.getJson", ["/x"])).toEqual({ ok: true });
		expect(seen).toEqual(["https://a.test/x"]);
	});
});

describe("server sync", () => {
	test("server value wins and is applied before extensions start; requests are authenticated", async () => {
		seed([{ package: parsePackage(cfg()), enabled: true, settings: { httpOrigin: "https://local.test", interval: 11 } }]);
		respond = req => req.path === "/extensions/settings" ? json({ settings: { "example.cfg": { httpOrigin: "https://server.test", interval: 22 } } }) : json({ settings: {} });
		const { host } = await boot();
		expect(requests[0]).toMatchObject({ method: "GET", path: "/extensions/settings", auth: "Bearer tok" });
		expect(host.installed[0]!.settings).toEqual({ httpOrigin: "https://server.test", interval: 22 });
		expect(host.installed[0]!.state).toBe("active");
		expect(request(host, "example.cfg", "settings.get")).toEqual({ httpOrigin: "https://server.test", interval: 22 });
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)[0].settings.interval).toBe(22); // cached locally
		expect(requests.filter(r => r.method === "PUT")).toEqual([]);
	});
	test("falls back to the cached copy without crashing when the server is unreachable", async () => {
		seed([{ package: parsePackage(cfg()), enabled: true, settings: { httpOrigin: "https://local.test", interval: 11 } }]);
		const rejections: unknown[] = [];
		const onRejection = (e: unknown) => rejections.push(e);
		process.on("unhandledRejection", onRejection);
		respond = () => { throw new TypeError("network down"); };
		const { host } = await boot();
		await flush();
		process.off("unhandledRejection", onRejection);
		expect(host.installed[0]!.state).toBe("active");
		expect(host.installed[0]!.settings).toEqual({ httpOrigin: "https://local.test", interval: 11 });
		expect(host.syncNotice).toContain("이 브라우저에 저장된 설정");
		expect(rejections).toEqual([]);
	});
	test("an error status or malformed body also falls back", async () => {
		seed([{ package: parsePackage(cfg()), enabled: true, settings: { httpOrigin: "https://local.test" } }]);
		respond = () => json({ error: { code: "x", message: "boom" } }, 500);
		expect((await boot()).host.installed[0]!.state).toBe("active");
		storage.delete("pipaya.extensions.booting"); storage.delete("pipaya.extensions.safe");
		respond = () => json({ settings: [1] });
		const { host } = await boot();
		expect(host.installed[0]!.settings.httpOrigin).toBe("https://local.test");
		expect(host.installed[0]!.state).toBe("active");
	});
	test("a hanging server is abandoned after 3 seconds and the extension still starts", async () => {
		seed([{ package: parsePackage(cfg()), enabled: true, settings: { httpOrigin: "https://local.test" } }]);
		respond = () => new Promise<Response>(() => {});
		const host = new ExtensionHost();
		host.init(makeAdapter().adapter);
		await new Promise(r => setTimeout(r, 200));
		expect(host.installed[0]!.state).toBe("disabled"); // still waiting: not started before the sync finished
		await new Promise(r => setTimeout(r, 3100));
		expect(host.installed[0]!.state).toBe("active");
	}, 8000);
	test("migration: local settings are PUT once when the server has nothing for the id", async () => {
		seed([
			{ package: parsePackage(cfg("example.one")), settings: { httpOrigin: "https://one.test" } },
			{ package: parsePackage(cfg("example.two")), settings: {} },
			{ package: parsePackage(cfg("example.three")), settings: { httpOrigin: "https://three.test" } },
		]);
		respond = req => req.path === "/extensions/settings" ? json({ settings: { "example.three": { httpOrigin: "https://server.test" } } }) : json({ settings: {} });
		const { host } = await boot();
		const puts = requests.filter(r => r.method === "PUT");
		expect(puts).toEqual([{ method: "PUT", path: "/extensions/example.one/settings", body: { settings: { httpOrigin: "https://one.test" } }, auth: "Bearer tok" }]);
		expect(host.installed.find(e => e.package.manifest.id === "example.three")!.settings.httpOrigin).toBe("https://server.test");
	});
	test("setSettings updates local state immediately and PUTs to the server", async () => {
		const { host } = await boot();
		const id = host.install(cfg());
		requests.length = 0;
		const pending = host.setSettings(id, { httpOrigin: "https://a.test" });
		expect(host.find(id).settings.httpOrigin).toBe("https://a.test"); // before the PUT settles
		await pending;
		expect(requests.filter(r => r.method === "PUT").at(-1)).toMatchObject({ path: "/extensions/example.cfg/settings", body: { settings: { httpOrigin: "https://a.test", interval: 30 } } });
		expect(host.syncNotice).toBe("");
	});
	test("a failed PUT shows a non-blocking notice, keeps the local value, and is retried on the next save", async () => {
		const { host } = await boot();
		const id = host.install(cfg());
		await flush();
		respond = () => { throw new TypeError("offline"); };
		await host.setSettings(id, { httpOrigin: "https://a.test" });
		expect(host.syncNotice).toBe("서버에 저장하지 못해 이 브라우저에만 저장됨");
		expect(host.find(id).settings.httpOrigin).toBe("https://a.test");
		respond = () => json({ settings: {} });
		requests.length = 0;
		await host.setSettings(id, { httpOrigin: "https://b.test" });
		expect(requests.filter(r => r.method === "PUT").at(-1)!.body.settings.httpOrigin).toBe("https://b.test");
		expect(host.syncNotice).toBe("");
	});
	test("uninstall with deleted settings sends DELETE (best effort, failure ignored)", async () => {
		const { host } = await boot();
		const id = host.install(cfg());
		await flush(); requests.length = 0;
		host.remove(id, { keepSettings: false });
		await flush();
		expect(requests).toEqual([{ method: "DELETE", path: "/extensions/example.cfg", body: undefined, auth: "Bearer tok" }]);
		const second = host.install(cfg("example.two"));
		await flush();
		respond = () => { throw new TypeError("offline"); };
		const rejections: unknown[] = [];
		const onRejection = (e: unknown) => rejections.push(e);
		process.on("unhandledRejection", onRejection);
		expect(() => host.remove(second, { keepSettings: false })).not.toThrow();
		await flush();
		process.off("unhandledRejection", onRejection);
		expect(rejections).toEqual([]);
		expect(host.installed).toEqual([]);
	});
	test("uninstall keeping settings sends no DELETE and keeps a local copy", async () => {
		const { host } = await boot();
		const id = host.install(cfg());
		await host.setSettings(id, { httpOrigin: "https://a.test", interval: 15 });
		await flush(); requests.length = 0;
		host.remove(id, { keepSettings: true });
		await flush();
		expect(requests).toEqual([]);
		expect(host.installed).toEqual([]);
		expect(JSON.parse(storage.get("pipaya.extensions.kept")!)).toEqual({ "example.cfg": { httpOrigin: "https://a.test", interval: 15 } });
	});
	test("deleting settings clears the kept copy, and reinstalling consumes it (configured, offline)", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg());
		await host.setSettings(id, { httpOrigin: "https://a.test", interval: 15 });
		host.remove(id, { keepSettings: true });
		expect(storage.has("pipaya.extensions.kept")).toBe(true);
		host.install(cfg());
		expect(host.find(id).settings).toEqual({ httpOrigin: "https://a.test", interval: 15 });
		expect(host.find(id).configured).toBe(true);
		expect(storage.has("pipaya.extensions.kept")).toBe(false); // consumed
		await host.enable(id);
		host.remove(id, { keepSettings: true });
		host.remove(host.install(cfg("example.other")), { keepSettings: true });
		host.install(cfg());
		host.remove(id, { keepSettings: false });
		expect(JSON.parse(storage.get("pipaya.extensions.kept") ?? "{}")["example.cfg"]).toBeUndefined();
	});
	test("reinstall prefers the server copy over the kept copy", async () => {
		respond = req => req.path === "/extensions/settings" ? json({ settings: { "example.cfg": { httpOrigin: "https://server.test", interval: 40 } } }) : json({ settings: {} });
		const { host } = await boot();
		storage.set("pipaya.extensions.kept", JSON.stringify({ "example.cfg": { httpOrigin: "https://kept.test" } }));
		host.install(cfg());
		expect(host.find("example.cfg").settings).toEqual({ httpOrigin: "https://server.test", interval: 40 });
		expect(host.find("example.cfg").configured).toBe(true);
	});
	test("the kept map holds at most 50 ids", async () => {
		const { host } = await boot(() => null);
		for (let i = 0; i < 55; i++) {
			const id = host.install(cfg(`example.k${i}`, null));
			await host.setSettings(id, { n: i });
			host.remove(id, { keepSettings: true });
		}
		const kept = JSON.parse(storage.get("pipaya.extensions.kept")!);
		expect(Object.keys(kept)).toHaveLength(50);
		expect(kept["example.k54"]).toEqual({ n: 54 });
		expect(kept["example.k0"]).toBeUndefined();
	});
	test("without a connection nothing touches the network", async () => {
		seed([{ package: parsePackage(cfg()), enabled: true, settings: { httpOrigin: "https://local.test" } }]);
		const { host } = await boot(() => null);
		await host.setSettings("example.cfg", { httpOrigin: "https://b.test" });
		host.remove("example.cfg", { keepSettings: false });
		await flush();
		expect(requests).toEqual([]);
	});
});

describe("configured gate for new packages with a settings schema", () => {
	test("a new schema package starts unconfigured; enable is refused until settings are saved explicitly", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg("example.cfg", [{ key: "interval", type: "number", label: "간격", default: 30 }]));
		expect(host.find(id).configured).toBe(false);
		expect(host.configRequired(id)).toBe(true);
		await expect(host.enable(id)).rejects.toThrow("먼저 설정을 저장해야 활성화할 수 있습니다");
		expect(host.find(id).state).toBe("disabled");
		expect(host.find(id).enabled).toBe(false);
		await host.setSettings(id, host.find(id).settings); // confirm the prefilled defaults
		expect(host.find(id).configured).toBe(true);
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)[0].configured).toBe(true);
		await host.enable(id);
		expect(host.find(id).state).toBe("active");
		host.install(cfg("example.cfg", [{ key: "interval", type: "number", label: "간격", default: 30 }])); // replacing keeps the value
		expect(host.find(id).configured).toBe(true);
	});
	test("replacing an unconfigured entry keeps it unconfigured; packages without a schema are never gated", async () => {
		const { host } = await boot(() => null);
		const id = host.install(cfg("example.cfg", [{ key: "interval", type: "number", label: "간격", default: 30 }]));
		host.install(cfg("example.cfg", [{ key: "interval", type: "number", label: "간격", default: 31 }]));
		expect(host.find(id).configured).toBe(false);
		const plain = host.install(cfg("example.plain", null));
		expect(host.configRequired(plain)).toBe(false);
		await host.enable(plain);
		expect(host.find(plain).state).toBe("active");
	});
	test("entries stored without the field are grandfathered as configured", async () => {
		seed([{ package: parsePackage(cfg()), settings: { httpOrigin: "https://a.test" } }]);
		const { host } = await boot(() => null);
		expect(host.installed[0]!.configured).toBe(true);
		await host.enable("example.cfg");
		expect(host.find("example.cfg").state).toBe("active");
	});
	test("a reinstall finds the settings on the server and counts as configured", async () => {
		respond = req => req.path === "/extensions/settings" ? json({ settings: { "example.cfg": { httpOrigin: "https://server.test" } } }) : json({ settings: {} });
		const { host } = await boot();
		host.install(cfg());
		expect(host.find("example.cfg").configured).toBe(true);
		expect(host.find("example.cfg").settings.httpOrigin).toBe("https://server.test");
	});
	test("boot never starts an unconfigured extension", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify([{ package: parsePackage(cfg("example.cfg", [{ key: "interval", type: "number", label: "간격", default: 30 }])), enabled: true, settings: {}, configured: false }]));
		const { host } = await boot(() => null);
		expect(host.installed[0]!.state).toBe("disabled");
		expect(host.installed[0]!.enabled).toBe(false);
		expect(host.installed[0]!.error).toBe("먼저 설정을 저장해야 활성화할 수 있습니다");
		expect(((globalThis as any).__fakeRuntimes as unknown[]).length).toBe(0);
	});
	test("a server sync that supplies settings marks the entry configured", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify([{ package: parsePackage(cfg("example.cfg", [{ key: "interval", type: "number", label: "간격", default: 30 }])), enabled: false, settings: {}, configured: false }]));
		respond = req => req.path === "/extensions/settings" ? json({ settings: { "example.cfg": { interval: 12 } } }) : json({ settings: {} });
		const { host } = await boot();
		expect(host.installed[0]!.configured).toBe(true);
	});
});

describe("never auto-disabling other extensions", () => {
	const ids = ["example.a", "example.b", "example.c"];
	test("installing C leaves enabled and active A and B untouched", async () => {
		const { host } = await boot(() => null);
		for (const id of ids.slice(0, 2)) { host.install(cfg(id, null)); await host.enable(id); }
		host.install(cfg(ids[2]!, null));
		for (const id of ids.slice(0, 2)) { expect(host.find(id).enabled).toBe(true); expect(host.find(id).state).toBe("active"); }
		expect(host.find("example.c").enabled).toBe(false);
		const stored = JSON.parse(storage.get("pipaya.extensions.v1")!);
		expect(stored.map((e: any) => e.enabled)).toEqual([true, true, false]);
	});
	test("a marker listing one id disables only that extension; the rest start; safe mode stays off", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify(ids.map(id => ({ package: parsePackage(cfg(id, null)), enabled: true, settings: {} }))));
		storage.set("pipaya.extensions.booting", JSON.stringify(["example.b"]));
		const { host } = await boot(() => null);
		expect(host.safeMode).toBe(false);
		expect(storage.has("pipaya.extensions.safe")).toBe(false);
		const b = host.find("example.b");
		expect(b.enabled).toBe(false); expect(b.state).toBe("disabled"); expect(b.error).toBe("시작이 완료되지 않아 비활성화했습니다");
		expect(host.find("example.a").state).toBe("active");
		expect(host.find("example.c").state).toBe("active");
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!).map((e: any) => e.enabled)).toEqual([true, false, true]);
		expect(storage.get("pipaya.extensions.booting")).toBeUndefined();
	});
	test("the marker holds an id only while its enable() is in flight, and is cleared on success and failure", async () => {
		const { host } = await boot(() => null);
		host.install(cfg("example.a", null));
		let release!: () => void;
		(globalThis as any).__fakeRuntimeStart = () => new Promise<void>(r => { release = r; });
		const pending = host.enable("example.a");
		expect(JSON.parse(storage.get("pipaya.extensions.booting")!)).toEqual(["example.a"]);
		release(); await pending;
		expect(storage.has("pipaya.extensions.booting")).toBe(false); // no 10 second tail
		(globalThis as any).__fakeRuntimeStart = async () => { throw new Error("boom"); };
		await expect(host.enable("example.a")).rejects.toThrow("boom");
		expect(storage.has("pipaya.extensions.booting")).toBe(false);
		delete (globalThis as any).__fakeRuntimeStart;
	});
	test("a start-up settings problem disables only the extension that has it", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify([
			{ package: parsePackage(cfg("example.bad")), enabled: true, settings: {} },
			{ package: parsePackage(cfg("example.good", null)), enabled: true, settings: {} },
		]));
		const { host } = await boot(() => null);
		expect(host.find("example.bad").enabled).toBe(false);
		expect(host.find("example.bad").error).toContain("필수 설정");
		expect(host.find("example.good").state).toBe("active");
		expect(host.safeMode).toBe(false);
	});
});

describe("unreadable stored entries are preserved", () => {
	const old = { package: { manifest: { id: "example.old", name: "Old One", version: "1.0.0", sdkVersion: 1, permissions: ["removed-permission"] } }, enabled: true, settings: { token: "keep-me" } };
	const good = { package: parsePackage(cfg("example.good", null)), enabled: false, settings: {} };
	test("init keeps the entry, reports it with best-effort id/name, and save() writes the raw element back untouched", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify([old, good]));
		const { host } = await boot(() => null);
		expect(host.installed.map(e => e.package.manifest.id)).toEqual(["example.good"]);
		expect(host.unreadable).toHaveLength(1);
		expect(host.unreadable[0]).toMatchObject({ id: "example.old", name: "Old One" });
		expect(host.unreadable[0]!.reason).toBeTruthy();
		expect(host.loadError).toBe("");
		host.install(cfg("example.new", null));
		const stored = JSON.parse(storage.get("pipaya.extensions.v1")!);
		expect(stored).toHaveLength(3);
		expect(stored.at(-1)).toEqual(old); // raw element unchanged, at the end
	});
	test("entries without any id still survive; both kinds count toward the 50 limit", async () => {
		const junk = [1, "x", { package: 5 }];
		storage.set("pipaya.extensions.v1", JSON.stringify([...junk, ...Array.from({ length: 47 }, (_, i) => ({ package: parsePackage(cfg(`example.e${i}`, null)), enabled: false, settings: {} }))]));
		const { host } = await boot(() => null);
		expect(host.unreadable.map(u => u.id)).toEqual([undefined, undefined, undefined]);
		expect(host.installed).toHaveLength(47);
		expect(() => host.install(cfg("example.over", null))).toThrow("최대 50개");
		expect(JSON.parse(storage.get("pipaya.extensions.v1") ?? "[]")).toHaveLength(50);
		host.removeUnreadable(0, { keepSettings: true });
		expect(host.install(cfg("example.fits", null))).toBe("example.fits");
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)).toHaveLength(50);
	});
	test("importing the same id replaces the unreadable entry and takes over its stored settings", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify([old]));
		const { host } = await boot(() => null);
		host.install(cfg("example.old", null));
		expect(host.unreadable).toEqual([]);
		expect(host.find("example.old").settings).toEqual({ token: "keep-me" });
		expect(host.find("example.old").enabled).toBe(false);
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)).toHaveLength(1);
	});
	test("removeUnreadable drops it; keepSettings keeps the stored settings locally, delete asks the server", async () => {
		storage.set("pipaya.extensions.v1", JSON.stringify([old, { ...old, package: { manifest: { ...old.package.manifest, id: "example.old2" } } }]));
		const { host } = await boot();
		requests.length = 0;
		host.removeUnreadable(0, { keepSettings: true });
		await flush();
		expect(requests).toEqual([]);
		expect(JSON.parse(storage.get("pipaya.extensions.kept")!)).toEqual({ "example.old": { token: "keep-me" } });
		host.removeUnreadable(0, { keepSettings: false });
		await flush();
		expect(requests.map(r => `${r.method} ${r.path}`)).toEqual(["DELETE /extensions/example.old2"]);
		expect(host.unreadable).toEqual([]);
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)).toEqual([]);
	});
	test("a corrupt list is backed up once before the first write and not silently replaced", async () => {
		storage.set("pipaya.extensions.v1", "{not json");
		const { host } = await boot(() => null);
		expect(host.loadError).toContain("확장 설정을 읽지 못했습니다");
		expect(storage.get("pipaya.extensions.v1")).toBe("{not json"); // untouched by init
		expect(storage.has("pipaya.extensions.v1.corrupt")).toBe(false);
		host.install(cfg("example.new", null));
		expect(storage.get("pipaya.extensions.v1.corrupt")).toBe("{not json");
		host.install(cfg("example.two", null));
		expect(storage.get("pipaya.extensions.v1.corrupt")).toBe("{not json");
		expect(JSON.parse(storage.get("pipaya.extensions.v1")!)).toHaveLength(2);
	});
});

describe("components", () => {
	test("settings form and navbar follow the compact/a11y requirements", async () => {
		const { compile } = await import("svelte/compiler");
		for (const f of ["extensions/SettingsForm", "Extensions", "extensions/InstalledDetail", "extensions/UnreadableCard", "extensions/RemoveConfirm", "extensions/ExtensionRow", "extensions/ExtensionPage", "extensions/ServerDetail", "extensions/NavbarItems", "Header"]) {
			const source = await Bun.file(`src/components/${f}.svelte`).text();
			expect(() => compile(source, { filename: `${f}.svelte`, generate: "client" }), f).not.toThrow();
		}
		const form = await Bun.file("src/components/extensions/SettingsForm.svelte").text();
		for (const needle of ["aria-invalid", "aria-describedby", "고급: JSON 직접 편집", "<Accordion", "disabled={disabled || !resolved.ok}"]) expect(form).toContain(needle);
		// the page is split into the list and its cards (Extensions, extensions/InstalledDetail, UnreadableCard, RemoveConfirm, ...): check them together
		const parts = ["Extensions", "extensions/InstalledDetail", "extensions/UnreadableCard", "extensions/RemoveConfirm", "extensions/ExtensionRow", "extensions/ServerDetail"];
		const page = (await Promise.all(parts.map((f) => Bun.file(`src/components/${f}.svelte`).text()))).join("\n");
		expect(page).toContain("settingsProblem(id)");
		expect(page).toContain("!!problem");
		for (const needle of ["이 확장을 삭제합니다. 설정값은 어떻게 할까요?", "설정 유지하고 삭제", "설정까지 삭제", "읽을 수 없음", "원본 내보내기", "이 버전에서 지원하지 않는 형식입니다", "알 수 없는 확장", "Escape", "role=\"group\"", "keepSettings"]) expect(page).toContain(needle);
		expect(page).toContain("확장을 삭제했습니다. 설정값은 유지했습니다.");
		expect(page).toContain("확장과 설정값을 삭제했습니다.");
		const navbar = await Bun.file("src/components/extensions/NavbarItems.svelte").text();
		expect(navbar).toContain("max-width: min(40%, 160px)");
		expect(navbar).toContain("gap: 6px");
	});
});

describe("language packs carried by an extension", () => {
	const pack = { tag: "ja", name: "日本語", messages: { "설정": "設定" } };
	const jaExt = (id = "lang.ja", locales: unknown = [pack]) => ({ manifest: { id, name: id, version: "1.0.0", sdkVersion: 1, permissions: ["locales"] }, locales });
	const saves = () => requests.filter(r => r.method === "PUT" && r.path.startsWith("/locales/"));

	test("schema: needs the locales permission, rejects built-ins, duplicates, bad tags and empty packs", () => {
		expect(parsePackage(jaExt()).locales).toEqual([pack]);
		expect(() => parsePackage({ ...jaExt(), manifest: { ...jaExt().manifest, permissions: [] } })).toThrow("locales permission");
		for (const bad of [[{ ...pack, tag: "ko" }], [{ ...pack, tag: "EN" }], [{ ...pack, tag: "ja_JP" }], [pack, pack], [{ ...pack, messages: {} }], [{ ...pack, messages: { a: "" } }], [{ ...pack, messages: { a: 1 } }], [{ ...pack, name: "" }], [{ ...pack, extra: 1 }], "ja"]) {
			expect(() => parsePackage(jaExt("lang.bad", bad)), JSON.stringify(bad)).toThrow();
		}
		expect(() => parsePackage(jaExt("lang.none", []))).toThrow(); // nothing to install
	});

	test("enabling adds the language at once and publishes it with the extension as owner", async () => {
		const { host } = await boot();
		host.install(jaExt());
		expect(i18nModule.languages().map(l => l.tag)).not.toContain("ja");
		await host.enable("lang.ja");
		await flush();
		expect(i18nModule.languages().find(l => l.tag === "ja")).toEqual({ tag: "ja", name: "日本語", builtIn: false });
		expect(i18nModule.translate("ja", "설정")).toBe("設定");
		expect(i18nModule.translate("ja", "닫기")).toBe("Close"); // not translated in the pack: English, not Korean
		expect(saves().map(r => [r.path, r.body, r.auth])).toEqual([["/locales/ja", { name: "日本語", messages: { "설정": "設定" }, owner: "lang.ja" }, "Bearer tok"]]);
	});

	test("disabling takes the language away again and a selected one falls back", async () => {
		const { host } = await boot();
		host.install(jaExt());
		await host.enable("lang.ja");
		i18nModule.setLangPref("ja");
		expect(i18nModule.getLang()).toBe("ja");
		host.disable("lang.ja");
		expect(i18nModule.languages().map(l => l.tag)).toEqual(["ko", "en"]);
		expect(i18nModule.getLang()).not.toBe("ja");
		expect(i18nModule.getLangPref()).toBe("ja"); // the choice is kept: it returns with the pack
		await host.enable("lang.ja");
		expect(i18nModule.getLang()).toBe("ja");
		i18nModule.setLangPref("system");
	});

	test("works offline (no connection) and a failed upload does not stop the extension", async () => {
		const offline = await boot(() => null);
		offline.host.install(jaExt("lang.off"));
		await offline.host.enable("lang.off");
		expect(i18nModule.translate("ja", "설정")).toBe("設定");
		expect(saves()).toEqual([]);
		offline.host.disable("lang.off");

		respond = () => new Response("nope", { status: 500 });
		const { host } = await boot();
		host.install(jaExt("lang.fail"));
		await host.enable("lang.fail");
		await flush();
		expect(host.find("lang.fail").state).toBe("active");
		expect(host.logs.some(l => l.owner === "lang.fail" && l.text.includes("ja"))).toBe(true);
		host.disable("lang.fail");
	});

	test("removing the extension unpublishes only its own packs", async () => {
		const { host } = await boot();
		host.install(jaExt());
		await host.enable("lang.ja");
		requests.length = 0;
		host.remove("lang.ja", { keepSettings: true });
		await flush();
		expect(requests.filter(r => r.method === "DELETE" && r.path.startsWith("/locales/")).map(r => r.path)).toEqual(["/locales/ja?owner=lang.ja"]);
		expect(i18nModule.languages().map(l => l.tag)).toEqual(["ko", "en"]);
	});

	test("a server pack is replaced by the extension's own copy while it is enabled", async () => {
		i18nModule.setRemotePacks([{ tag: "ja", name: "server", messages: { "설정": "サーバー" }, updatedAt: 1 }]);
		expect(i18nModule.translate("ja", "설정")).toBe("サーバー");
		const { host } = await boot();
		host.install(jaExt());
		await host.enable("lang.ja");
		expect(i18nModule.translate("ja", "설정")).toBe("設定");
		host.disable("lang.ja");
		expect(i18nModule.translate("ja", "설정")).toBe("サーバー");
		i18nModule.setRemotePacks([]);
	});
});
