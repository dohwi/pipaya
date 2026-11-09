import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { ExtensionHost as ExtensionHostType, HostAdapter } from "../src/lib/extensions/host.svelte";

// The installed list belongs to the server: what a server switch, a sync or an import touches.
// The real rune module is compiled with Svelte. Only the iframe/Worker runtime is replaced by a
// recording fake, so host logic (permissions, generations, cleanup, persistence) is the real code.
const FAKE_RUNTIME = `
const created = (globalThis.__fakeRuntimes ??= []);
export class ExtensionRuntime {
	executed = []; events = []; stopped = false; pkg = null;
	constructor(callbacks) { this.callbacks = callbacks; created.push(this); }
	async start(pkg) { this.pkg = pkg; await globalThis.__fakeRuntimeStart?.(this); }
	execute(token, arg = "") {
		if (this.stopped) return Promise.reject(new Error("stopped"));
		this.executed.push({ token, arg });
		return Promise.resolve();
	}
	event(event) { if (!this.stopped) this.events.push(event); }
	stop() { this.stopped = true; }
}
`;

interface FakeRuntime {
	callbacks: { request(method: string, args: unknown[]): unknown; failed(error: string): void };
	executed: { token: string; arg: string }[];
	events: unknown[];
	stopped: boolean;
}
type Host = ExtensionHostType;
let ExtensionHost: new () => Host;
let dir: string;

// Minimal browser globals, backed by plain maps.
const storage = new Map<string, string>();
const styles = new Map<string, string>();
const loc = { search: "" };
function defineGlobal(name: string, value: unknown) {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
defineGlobal("localStorage", {
	getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
	setItem: (k: string, v: string) => { storage.set(k, String(v)); },
	removeItem: (k: string) => { storage.delete(k); },
	clear: () => storage.clear(),
});
defineGlobal("location", loc);
defineGlobal("document", {
	documentElement: { style: {
		setProperty: (k: string, v: string) => { styles.set(k, v); },
		removeProperty: (k: string) => { const old = styles.get(k) ?? ""; styles.delete(k); return old; },
	} },
});

const runtimes = () => ((globalThis as any).__fakeRuntimes ??= []) as FakeRuntime[];

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-extensions-host-"));
	const fakeFile = join(dir, "fake-runtime.js");
	await writeFile(fakeFile, FAKE_RUNTIME);
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/extensions/host.svelte.ts")], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /^\.\/runtime$/ }, () => ({ path: fakeFile }));
			builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), {
					compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
				}).outputText;
				return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "host.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	ExtensionHost = (await import(file)).ExtensionHost;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
	storage.clear(); styles.clear(); loc.search = "";
	runtimes().length = 0;
	delete (globalThis as any).__fakeRuntimeStart;
});

// ---- helpers ----
let server: string | null = "a";
let shared = 0;
function newHost() {
	const host = new ExtensionHost();
	host.init({
		prefill: () => {}, notify: () => {}, dark: () => true, reservedCommands: () => ["help"],
		context: () => ({ sessionId: "s1", model: "m", provider: "p", running: false, online: true }),
		serverId: () => server,
		listChanged: () => { shared++; },
		configuration: { capture: () => ({ servers: [{ name: "S", baseUrl: "http://a.test" }], preferences: {}, keybindings: { newChat: "Mod+K" } }), apply: () => {}, backup: () => ({}), restore: () => {}, confirm: async () => true },
	} as unknown as HostAdapter);
	return host;
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));
const pkg = (id: string) => ({ manifest: { id, name: `Name ${id}`, version: "1.0.0", sdkVersion: 1, permissions: ["commands", "composer"] }, commands: [{ name: id, description: "d", template: "t {{args}}" }] });
const ids = (host: Host) => host.installed.map(e => e.package.manifest.id).sort();
beforeEach(() => { server = "a"; shared = 0; });

describe("the installed list belongs to the server", () => {
	test("an installed extension is kept under the open server", () => {
		const host = newHost();
		host.install(pkg("one"));
		expect(JSON.parse(storage.get("pipaya.extensions.v1.a")!).map((e: any) => e.package.manifest.id)).toEqual(["one"]);
		expect(storage.has("pipaya.extensions.device.v1")).toBe(false);
	});

	test("the list comes back after a reload", async () => {
		newHost().install(pkg("one"));
		const again = newHost(); await flush();
		expect(ids(again)).toEqual(["one"]);
	});

	test("the list a device had before scopes existed is read as the server's", () => {
		storage.set("pipaya.extensions.v1.a", JSON.stringify([{ package: pkg("old"), enabled: false, settings: {}, configured: true }]));
		const host = newHost();
		expect(ids(host)).toEqual(["old"]);
	});

	test("a device-only list from before is folded into the open server's list once", () => {
		storage.set("pipaya.extensions.device.v1", JSON.stringify([{ package: pkg("mine"), enabled: false, settings: {}, configured: true }]));
		storage.set("pipaya.extensions.v1.a", JSON.stringify([{ package: pkg("theirs"), enabled: false, settings: {}, configured: true }]));
		const host = newHost();
		expect(ids(host)).toEqual(["mine", "theirs"]);
		expect(storage.has("pipaya.extensions.device.v1")).toBe(false);
		expect(JSON.parse(storage.get("pipaya.extensions.v1.a")!).map((e: any) => e.package.manifest.id).sort()).toEqual(["mine", "theirs"]);
	});

	test("every extension is shared with the server", () => {
		const host = newHost();
		host.install(pkg("one"));
		host.install(pkg("two"));
		expect((host.packages() as any[]).map(p => p.manifest.id)).toEqual(["one", "two"]);
	});

	test("installing or removing tells the server", () => {
		const host = newHost();
		host.install(pkg("one"));
		const before = shared;
		host.remove("one", { keepSettings: true });
		expect(shared).toBe(before + 1);
	});

	test("switching server swaps the whole list", async () => {
		const host = newHost();
		host.install(pkg("a-only"));
		server = "b";
		storage.set("pipaya.extensions.v1.b", JSON.stringify([{ package: pkg("b-only"), enabled: false, settings: {}, configured: true }]));
		await host.switchServer();
		expect(ids(host)).toEqual(["b-only"]);
		server = "a"; await host.switchServer();
		expect(ids(host)).toEqual(["a-only"]);
	});

	test("an extension of the server that is left stops running on a switch", async () => {
		const host = newHost();
		const id = host.install({ ...pkg("one"), code: "/* fake */" });
		await host.enable(id);
		const runtime = (globalThis as any).__fakeRuntimes.at(-1);
		server = "b"; await host.switchServer();
		expect(runtime.stopped).toBe(true);
		expect(host.installed).toEqual([]);
	});

	test("the server's list adds new packages switched off and drops the ones it no longer has", () => {
		const host = newHost();
		host.install(pkg("gone"));
		host.applyPackages([pkg("fresh")]);
		expect(ids(host)).toEqual(["fresh"]);
		expect(host.find("fresh").enabled).toBe(false);
	});

	test("an unreadable entry stays in the list, and is written back unchanged", () => {
		storage.set("pipaya.extensions.v1.a", JSON.stringify([{ package: { manifest: { id: "future" } }, enabled: true }]));
		const host = newHost();
		expect(host.unreadable.map(u => u.id)).toEqual(["future"]);
		host.install(pkg("another"));
		expect(JSON.parse(storage.get("pipaya.extensions.v1.a")!).length).toBe(2);
	});

	test("a backup keeps the entries and the device-only settings ids", () => {
		const host = newHost();
		host.install(pkg("one"));
		const backup = (host as any).configIO("").backup();
		expect(backup.entries.map((e: any) => e.package.manifest.id)).toEqual(["one"]);
		expect(backup.entries[0].scope).toBeUndefined();
	});

	test("the settings file carries shortcuts and servers, never extensions", () => {
		const host = newHost();
		host.install(pkg("one"));
		const doc = host.exportConfiguration({ servers: true, extensions: true, preferences: true });
		expect(doc.extensions).toEqual([]);
		expect(doc.keybindings).toEqual({ newChat: "Mod+K" });
		expect(doc.servers.map(s => s.baseUrl)).toEqual(["http://a.test"]);
		expect(host.exportConfiguration({ servers: false, extensions: false, preferences: false, keybindings: false }).keybindings).toBeUndefined();
	});

	test("importing a file installs its extensions on the server, switched off", () => {
		const host = newHost();
		host.importConfiguration({ schemaVersion: 1, servers: [], preferences: {}, extensions: [{ package: pkg("from-file") as any, enabled: true, settings: {} }] });
		expect(host.find("from-file").enabled).toBe(false);
		expect(JSON.parse(storage.get("pipaya.extensions.v1.a")!).map((e: any) => e.package.manifest.id)).toEqual(["from-file"]);
	});

	test("importing a file over an installed extension replaces it in place", () => {
		const host = newHost();
		host.install(pkg("shared"));
		host.importConfiguration({ schemaVersion: 1, servers: [], preferences: {}, extensions: [{ package: { ...pkg("shared"), manifest: { ...pkg("shared").manifest, version: "2.0.0" } } as any, enabled: false, settings: {} }] });
		expect(host.find("shared").package.manifest.version).toBe("2.0.0");
	});

	test("an extension asking for the settings never gets the shortcuts", () => {
		const host = newHost();
		const doc = (host as any).configIO("some.extension").capture();
		expect(doc.keybindings).toBeUndefined();
		expect((host as any).configIO("").capture().keybindings).toEqual({ newChat: "Mod+K" });
	});
});
