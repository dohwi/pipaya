import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { ExtensionHost as ExtensionHostType, ExtensionContext, HostAdapter } from "../src/lib/extensions/host.svelte";

// Server vs device scope: where an extension is installed and what a server switch or sync touches.
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
	dir = await mkdtemp(join(tmpdir(), "harness-extensions-host-"));
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
const ids = (host: Host, scope?: "server" | "device") => host.installed.filter(e => !scope || e.scope === scope).map(e => e.package.manifest.id).sort();
beforeEach(() => { server = "a"; shared = 0; });

describe("extension scope", () => {
	test("a server extension goes to the open server's list, a device extension to the device's", () => {
		const host = newHost();
		host.install(pkg("on-server"));
		host.install(pkg("on-device"), "device");
		expect(JSON.parse(storage.get("pipaya.extensions.v1.a")!).map((e: any) => e.package.manifest.id)).toEqual(["on-server"]);
		expect(JSON.parse(storage.get("pipaya.extensions.device.v1")!).map((e: any) => e.package.manifest.id)).toEqual(["on-device"]);
	});

	test("both lists come back after a reload, each with its scope", async () => {
		newHost().install(pkg("on-server")); 
		const first = newHost(); first.install(pkg("on-device"), "device");
		const again = newHost(); await flush();
		expect(ids(again, "server")).toEqual(["on-server"]);
		expect(ids(again, "device")).toEqual(["on-device"]);
	});

	test("the list a device had before scopes existed is all server extensions", () => {
		storage.set("pipaya.extensions.v1.a", JSON.stringify([{ package: pkg("old"), enabled: false, settings: {}, configured: true }]));
		const host = newHost();
		expect(host.installed.map(e => [e.package.manifest.id, e.scope])).toEqual([["old", "server"]]);
		expect(storage.has("pipaya.extensions.device.v1")).toBe(false);
	});

	test("only server extensions are shared with the server", () => {
		const host = newHost();
		host.install(pkg("on-server"));
		host.install(pkg("on-device"), "device");
		expect((host.packages() as any[]).map(p => p.manifest.id)).toEqual(["on-server"]);
	});

	test("changing a device extension does not tell the server anything", () => {
		const host = newHost();
		host.install(pkg("on-server"));
		const before = shared;
		host.install(pkg("on-device"), "device");
		host.remove("on-device", { keepSettings: true });
		expect(shared).toBe(before);
		host.remove("on-server", { keepSettings: true });
		expect(shared).toBe(before + 1);
	});

	test("switching server swaps the server extensions and keeps the device ones", async () => {
		const host = newHost();
		host.install(pkg("a-only"));
		host.install(pkg("mine"), "device");
		server = "b";
		storage.set("pipaya.extensions.v1.b", JSON.stringify([{ package: pkg("b-only"), enabled: false, settings: {}, configured: true }]));
		await host.switchServer();
		expect(ids(host, "server")).toEqual(["b-only"]);
		expect(ids(host, "device")).toEqual(["mine"]);
		server = "a"; await host.switchServer();
		expect(ids(host, "server")).toEqual(["a-only"]);
		expect(ids(host, "device")).toEqual(["mine"]);
	});

	test("a device extension keeps running across a server switch", async () => {
		const host = newHost();
		const id = host.install({ ...pkg("mine"), code: "/* fake */" }, "device");
		await host.enable(id);
		const runtime = (globalThis as any).__fakeRuntimes.at(-1);
		server = "b"; await host.switchServer();
		expect(host.find(id).state).toBe("active");
		expect(runtime.stopped).toBe(false);
	});

	test("the server's list never removes or replaces a device extension", () => {
		const host = newHost();
		host.install(pkg("mine"), "device");
		host.install(pkg("shared-one"));
		host.applyPackages([{ ...pkg("mine"), manifest: { ...pkg("mine").manifest, version: "9.9.9" } }]); // same id, from the server
		expect(host.find("mine").scope).toBe("device");
		expect(host.find("mine").package.manifest.version).toBe("1.0.0");
		expect(ids(host, "server")).toEqual([]); // shared-one is gone from the server's list, as before
		expect(ids(host, "device")).toEqual(["mine"]);
	});

	test("the server adds new packages as server extensions, switched off", () => {
		const host = newHost();
		host.applyPackages([pkg("fresh")]);
		expect(host.find("fresh").scope).toBe("server");
		expect(host.find("fresh").enabled).toBe(false);
	});

	test("a device extension with the same id as a server one wins when both are stored", () => {
		storage.set("pipaya.extensions.device.v1", JSON.stringify([{ package: pkg("dup"), enabled: false, settings: {}, configured: true }]));
		storage.set("pipaya.extensions.v1.a", JSON.stringify([{ package: pkg("dup"), enabled: false, settings: {}, configured: true }]));
		const host = newHost();
		expect(host.installed.map(e => [e.package.manifest.id, e.scope])).toEqual([["dup", "device"]]);
		expect(host.unreadable.length).toBe(1); // the server's copy is kept, not deleted
	});

	test("with no server open an extension can still be installed on the device", () => {
		server = null;
		const host = newHost();
		host.install(pkg("mine"), "device");
		expect(ids(host, "device")).toEqual(["mine"]);
		expect(host.packages() ?? []).toEqual([]); // nothing of the device's goes to a server
	});

	test("an unreadable entry stays in the list it came from", () => {
		storage.set("pipaya.extensions.device.v1", JSON.stringify([{ package: { manifest: { id: "future" } }, enabled: true }]));
		const host = newHost();
		expect(host.unreadable.map(u => [u.id, u.scope])).toEqual([["future", "device"]]);
		host.install(pkg("another"), "device");
		expect(JSON.parse(storage.get("pipaya.extensions.device.v1")!).length).toBe(2);
		expect(JSON.parse(storage.get("pipaya.extensions.v1.a")!)).toEqual([]);
	});

	test("a backup keeps each extension's scope", () => {
		const host = newHost();
		host.install(pkg("on-server"));
		host.install(pkg("on-device"), "device");
		const entries = (host as any).configIO("").backup().entries as any[];
		expect(entries.map(e => [e.package.manifest.id, e.scope]).sort()).toEqual([["on-device", "device"], ["on-server", "server"]]);
	});

	test("the settings file carries this device's extensions and shortcuts, not the server's extensions", () => {
		const host = newHost();
		host.install(pkg("on-server"));
		host.install(pkg("on-device"), "device");
		const doc = host.exportConfiguration({ servers: true, extensions: true, preferences: true });
		expect(doc.extensions.map(e => e.package.manifest.id)).toEqual(["on-device"]);
		expect(doc.keybindings).toEqual({ newChat: "Mod+K" });
		expect(doc.servers.map(s => s.baseUrl)).toEqual(["http://a.test"]);
		expect(host.exportConfiguration({ servers: false, extensions: false, preferences: false, keybindings: false }).keybindings).toBeUndefined();
	});

	test("importing a file installs its extensions on the device, switched off", () => {
		const host = newHost();
		host.importConfiguration({ schemaVersion: 1, servers: [], preferences: {}, extensions: [{ package: pkg("from-file") as any, enabled: true, settings: {} }] });
		expect(host.find("from-file").scope).toBe("device");
		expect(host.find("from-file").enabled).toBe(false);
		expect(storage.has("pipaya.extensions.device.v1")).toBe(true);
	});

	test("importing a file over a server extension keeps it on the server", () => {
		const host = newHost();
		host.install(pkg("shared"));
		host.importConfiguration({ schemaVersion: 1, servers: [], preferences: {}, extensions: [{ package: { ...pkg("shared"), manifest: { ...pkg("shared").manifest, version: "2.0.0" } } as any, enabled: false, settings: {} }] });
		expect(host.find("shared").scope).toBe("server");
		expect(host.find("shared").package.manifest.version).toBe("2.0.0");
	});

	test("an extension asking for the settings never gets the shortcuts", () => {
		const host = newHost();
		const doc = (host as any).configIO("some.extension").capture();
		expect(doc.keybindings).toBeUndefined();
		expect((host as any).configIO("").capture().keybindings).toEqual({ newChat: "Mod+K" });
	});
});
