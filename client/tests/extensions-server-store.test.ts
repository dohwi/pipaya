import { beforeEach, describe, expect, test } from "bun:test";
import { ServerExtensionStore, type ListStorage } from "../src/lib/extensions/server-store";
import { ServerSettingsSync } from "../src/lib/server-settings";

// The idle editor of a saved server that is NOT the open one: it must read and write only its own server's list and
// connection, so editing one server can never touch another (the open one included).

const pkg = (id: string, extra: Record<string, unknown> = {}) => ({
	manifest: { id, name: `Name ${id}`, version: "1.0.0", sdkVersion: 1, permissions: ["commands", "composer"], ...extra },
	commands: [{ name: id, description: "d", template: "t {{args}}" }],
});
const withSettings = (id: string) => pkg(id, { settings: [{ key: "token", type: "string", label: "Token", required: true, default: "" }] });

class MemoryStorage implements ListStorage {
	map = new Map<string, string>();
	getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
	setItem(k: string, v: string) { this.map.set(k, v); }
}

/** A fake server connection that records what was sent to it. */
function fakeApi(name: string, log: string[]) {
	return {
		name,
		saveExtensionSettings: async (id: string, settings: unknown) => { log.push(`${name}:save:${id}:${JSON.stringify(settings)}`); return { settings }; },
		deleteExtension: async (id: string) => { log.push(`${name}:delete:${id}`); return { ok: true }; },
		extensionSettings: async () => ({ settings: {} }),
	} as any;
}

let storage: MemoryStorage;
let log: string[];
let changes: string[];
beforeEach(() => { storage = new MemoryStorage(); log = []; changes = []; });

function make(serverId: string, api: ReturnType<typeof fakeApi> | null) {
	return new ServerExtensionStore({
		serverId, storage, api: () => api,
		changed: (key) => changes.push(`${serverId}:${key}`),
	});
}

describe("server extension store", () => {
	test("each server keeps its own list under its own key", () => {
		const a = make("a", fakeApi("A", log)), b = make("b", fakeApi("B", log));
		a.install(pkg("only-a"));
		b.install(pkg("only-b"));
		expect(JSON.parse(storage.map.get("pipaya.extensions.v1.a")!).map((e: any) => e.package.manifest.id)).toEqual(["only-a"]);
		expect(JSON.parse(storage.map.get("pipaya.extensions.v1.b")!).map((e: any) => e.package.manifest.id)).toEqual(["only-b"]);
		expect(make("a", null).installed.map((e) => e.package.manifest.id)).toEqual(["only-a"]);
	});

	test("a change is reported for its own server only", () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x"));
		b.setEnabled("x", true);
		expect(changes.every((c) => c.startsWith("b:"))).toBe(true);
		expect(changes).toContain("b:extensions");
		expect(changes).toContain("b:extensionStates");
	});

	test("switching on only records the choice; it never starts anything and survives a reload", () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x"));
		expect(b.states()).toBeUndefined();
		b.setEnabled("x", true);
		expect(b.states()).toEqual({ x: true });
		expect(make("b", null).installed[0]!.enabled).toBe(true);
	});

	test("settings go to this server's connection, never another's", async () => {
		const apiA = fakeApi("A", log), apiB = fakeApi("B", log);
		make("a", apiA);
		const b = make("b", apiB);
		b.install(pkg("x", { settings: [{ key: "n", type: "string", label: "N", default: "" }] }));
		await b.setSettings("x", { n: "hello" });
		expect(log).toEqual([`B:save:x:${JSON.stringify({ n: "hello" })}`]);
	});

	test("settings are not kept when the server could not take them", async () => {
		const b = make("b", null);
		b.install(pkg("x", { settings: [{ key: "n", type: "string", label: "N", default: "" }] }));
		await expect(b.setSettings("x", { n: "lost" })).rejects.toThrow();
		expect(b.installed[0]!.settings).not.toEqual({ n: "lost" });
	});

	test("a settings-only-local extension is saved without any request", async () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x", { settingsScope: "local", settings: [{ key: "n", type: "string", label: "N", default: "" }] }));
		await b.setSettings("x", { n: "mine" });
		expect(log).toEqual([]);
		expect(b.find("x").settings).toEqual({ n: "mine" });
	});

	test("deleting with settings removes them on this server only", async () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x"));
		await b.remove("x", { keepSettings: false });
		expect(log).toEqual(["B:delete:x"]);
		expect(b.installed).toEqual([]);
	});

	test("deleting while keeping settings sends nothing", async () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x"));
		await b.remove("x", { keepSettings: true });
		expect(log).toEqual([]);
	});

	test("a package with a required settings schema cannot be switched on before its first save", () => {
		const b = make("b", fakeApi("B", log));
		b.install(withSettings("x"));
		expect(b.configRequired("x")).toBe(true);
	});

	test("replacing a package that was on switches it off and says so", () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x"));
		b.setEnabled("x", true);
		changes.length = 0;
		b.install(pkg("x"));
		expect(b.find("x").enabled).toBe(false);
		expect(b.states()).toEqual({ x: false });
		expect(changes).toContain("b:extensionStates");
	});

	test("an entry this version cannot read is written back unchanged", () => {
		storage.setItem("pipaya.extensions.v1.b", JSON.stringify([{ package: { nonsense: true }, enabled: true }, { package: pkg("ok"), enabled: false, settings: {}, configured: true }]));
		const b = make("b", fakeApi("B", log));
		expect(b.unreadable.length).toBe(1);
		b.install(pkg("new"));
		const kept = JSON.parse(storage.map.get("pipaya.extensions.v1.b")!);
		expect(kept.some((e: any) => e.package?.nonsense === true)).toBe(true);
		expect(kept.length).toBe(3);
	});

	test("at most 50 per server, counted per server", () => {
		const a = make("a", fakeApi("A", log)), b = make("b", fakeApi("B", log));
		const name = (i: number) => `e${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
		for (let i = 0; i < 50; i++) a.install(pkg(name(i)));
		expect(() => a.install(pkg("overflow"))).toThrow();
		expect(() => b.install(pkg("fits"))).not.toThrow();
	});

	test("a list from the server replaces this one: new arrive off, changed lose consent, missing go", () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("keep")); b.install(pkg("gone"));
		b.setEnabled("keep", true);
		b.applyPackages([{ ...pkg("keep"), commands: [{ name: "keep", description: "changed", template: "x" }] }, pkg("fresh")]);
		expect(b.installed.map((e) => e.package.manifest.id).sort()).toEqual(["fresh", "keep"]);
		expect(b.find("keep").enabled).toBe(false);
		expect(b.find("fresh").enabled).toBe(false);
		expect(b.states()?.gone).toBeUndefined();
	});

	test("on/off choices from the server are followed and do not bounce back as an edit", () => {
		const b = make("b", fakeApi("B", log));
		b.install(pkg("x"));
		changes.length = 0;
		b.applyStates({ x: true, "not valid!": true });
		expect(b.find("x").enabled).toBe(true);
		expect(changes).toEqual([]);
	});
});

describe("two idle servers through the sync engine", () => {
	test("a change on one is uploaded to its own server and the other server is never asked", async () => {
		const puts: string[] = [];
		const syncApi = (name: string) => ({
			clientSettings: async () => ({ settings: {} }),
			clientSetting: async () => ({ value: null, updatedAt: 0 }),
			putClientSetting: async (key: string, _v: unknown, at: number) => { puts.push(`${name}:${key}`); return { value: _v, updatedAt: at, applied: true }; },
		});
		const holders: Record<string, { sync?: ServerSettingsSync }> = { a: {}, b: {} };
		const stores: Record<string, ServerExtensionStore> = {};
		for (const id of ["a", "b"]) {
			stores[id] = new ServerExtensionStore({ serverId: id, storage, api: () => fakeApi(id, log), changed: (k) => holders[id]!.sync?.changed(k) });
			holders[id]!.sync = new ServerSettingsSync({
				api: syncApi(id), origin: "me", storage, storageKey: `sync.${id}`, debounceMs: 0,
				adapters: { extensions: { read: () => stores[id]!.packages(), apply: (v) => stores[id]!.applyPackages(v) }, extensionStates: { read: () => stores[id]!.states(), apply: (v) => stores[id]!.applyStates(v) } },
			});
		}
		stores.b!.install(pkg("x"));
		await holders.b!.sync!.flush();
		expect(puts).toEqual(["b:extensions"]);
	});
});
