import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { ExtensionHost as ExtensionHostType, ExtensionContext, HostAdapter } from "../src/lib/extensions/host.svelte";

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
		return Promise.resolve(globalThis.__fakeReturn?.[token] ?? null);
	}
	event(event) { if (!this.stopped) this.events.push(event); }
	serverEvent(event) { if (!this.stopped) (this.serverEvents ??= []).push(event); }
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
const styleEls: { dataset: Record<string, string>; textContent: string; removed: boolean }[] = [];
defineGlobal("document", {
	createElement: () => { const el = { dataset: {} as Record<string, string>, textContent: "", removed: false, remove() { el.removed = true; } }; return el; },
	head: { append: (el: (typeof styleEls)[number]) => { styleEls.push(el); } },
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
	// Compiling real Svelte and linking the app kit is covered by extensions-components.test.ts; the host only needs the result.
	const componentsFile = join(dir, "fake-components.js");
	await writeFile(componentsFile, `export function loadComponents(pkg) { if (globalThis.__componentsError) throw new Error(globalThis.__componentsError); return Object.fromEntries(Object.keys(pkg.components).map(n => [n, { name: n }])); }`);
	const kitFile = join(dir, "fake-kit.js");
	await writeFile(kitFile, `export function kit(id, data) { return { id, data }; }`);
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/extensions/host.svelte.ts")], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /^\.\/runtime$/ }, () => ({ path: fakeFile }));
			builder.onResolve({ filter: /^\.\/components$/ }, () => ({ path: componentsFile }));
			builder.onResolve({ filter: /^\.\/kit$/ }, () => ({ path: kitFile }));
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
	delete (globalThis as any).__componentsError;
	styleEls.length = 0;
});

// ---- helpers ----
const CONTEXT: ExtensionContext = { sessionId: "s1", model: "model-x", provider: "prov", running: false, online: true, language: "ko" };
function makeAdapter(opts: { dark?: boolean; context?: () => unknown } = {}) {
	const calls = { prefill: [] as string[], notify: [] as string[] };
	const adapter: HostAdapter = {
		prefill: t => { calls.prefill.push(t); },
		notify: t => { calls.notify.push(t); },
		context: (opts.context ?? (() => ({ ...CONTEXT }))) as () => ExtensionContext,
		dark: () => opts.dark ?? true,
		reservedCommands: () => ["help", "stop"],
	};
	return { adapter, calls };
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));
function newHost(opts?: Parameters<typeof makeAdapter>[0]) {
	const host = new ExtensionHost();
	const a = makeAdapter(opts);
	host.init(a.adapter);
	return { host, ...a };
}
async function reload(opts?: Parameters<typeof makeAdapter>[0]) {
	const r = newHost(opts);
	await flush();
	return r;
}
function pkg(id: string, permissions: string[], extra: Record<string, unknown> = {}, version = "1.0.0") {
	return { manifest: { id, name: `Name ${id}`, version, sdkVersion: 1, permissions }, ...extra };
}
const THEME = { dark: { "--bg": "#111111" }, light: { "--bg": "#ffffff" } };
const decl = (id: string, names: string[] = ["summarize"], extra: Record<string, unknown> = {}) =>
	pkg(id, ["commands", "composer"], {
		commands: names.map(name => ({ name, description: `${name} desc`, template: `Template ${name}: {{args}}` })),
		...extra,
	});
const ALL = ["commands", "composer", "status", "context", "storage", "notifications", "events"];
const code = (id: string, permissions: string[] = ALL, extra: Record<string, unknown> = {}) =>
	pkg(id, permissions, { code: "/* fake */", ...extra });

async function activate(host: Host, p: { manifest: { id: string } }) {
	const id = host.install(p);
	await host.enable(id);
	return { id, runtime: runtimes().at(-1)! };
}
// Invoke the private capability-checked request handler directly.
function call(host: Host, id: string, method: string, args: unknown[] = [], runtime?: FakeRuntime): any {
	return (host as unknown as { request(id: string, m: string, a: unknown[], r: unknown): unknown })
		.request(id, method, args, runtime ?? runtimes().at(-1));
}
const storageKeys = () => [...storage.keys()];

describe("system notification SDK", () => {
	test("old toast permission does not grant OS/push access", async () => {
		const { host } = newHost(); const { id } = await activate(host, code("example.notify", ["notifications"]));
		for (const method of ["send", "status", "register", "remove"]) expect(() => call(host, id, `notifications.${method}`, [])).toThrow(/권한|permission/i);
	});
	test("validates data, shows extension origin, exposes no tokens, and revokes on disable", async () => {
		const { host, adapter } = newHost(); const calls: unknown[] = []; const revoked: string[] = [];
		adapter.systemNotifications = {
			send: async (owner, spec) => { calls.push({ owner, spec }); return { id: "n", delivered: 1, suppressed: false }; },
			status: async () => ({ enabled: true, permission: "granted", pushConfigured: true }),
			register: async (owner, id, rule) => { calls.push({ owner, id, rule }); },
			remove: async (owner, id) => { calls.push({ owner, id }); },
			revoke: async owner => { revoked.push(owner); },
		};
		const { id } = await activate(host, code("example.push", ["system-notifications"]));
		expect(await call(host, id, "notifications.status")).toEqual({ enabled: true, permission: "granted", pushConfigured: true });
		await call(host, id, "notifications.send", [{ title: "요청", kind: "user_request" }]);
		expect(calls[0]).toEqual({ owner: id, spec: { title: "[Name example.push] 요청", kind: "user_request" } });
		for (const args of [[], [{ title: "ok", force: true }], [{ title: "x".repeat(101) }], [{ title: "ok" }, "extra"]]) expect(() => call(host, id, "notifications.send", args)).toThrow();
		await call(host, id, "notifications.register", ["done", { event: "run_finished", title: "완료" }]);
		expect(() => call(host, id, "notifications.register", ["done", { event: "message_end", title: "no" }])).toThrow();
		host.disable(id); expect(revoked).toEqual([id]);
	});
});

describe("declarative extensions", () => {
	test("install leaves the extension disabled with nothing registered", () => {
		const { host, calls } = newHost();
		const id = host.install(decl("example.alpha", ["summarize"], { theme: THEME }));
		const e = host.find(id);
		expect(e.enabled).toBe(false);
		expect(e.state).toBe("disabled");
		expect(host.commands).toEqual([]);
		expect(styles.size).toBe(0);
		expect(runtimes()).toHaveLength(0);
		expect(calls.prefill).toEqual([]);
	});

	test("enable registers template commands that only prefill and never send", async () => {
		const { host, calls } = newHost();
		const id = host.install(decl("example.alpha", ["summarize", "review"]));
		await host.enable(id);
		expect(host.find(id).state).toBe("active");
		expect(host.commands.map(c => [c.owner, c.name]).sort()).toEqual([[id, "review"], [id, "summarize"]]);
		expect(calls.prefill).toEqual([]);
		await host.commands.find(c => c.name === "summarize")!.run("hello {{args}} world");
		expect(calls.prefill).toEqual(["Template summarize: hello {{args}} world"]);
		expect(calls.notify).toEqual([]);
		expect(runtimes()).toHaveLength(0); // declarative packages never start a runtime
	});

	test("reserved command names fail cleanly and leave no orphans", async () => {
		const { host, calls } = newHost();
		const id = host.install(decl("example.alpha", ["summarize", "help"], { theme: THEME }));
		await expect(host.enable(id)).rejects.toThrow();
		const e = host.find(id);
		expect(e.state).toBe("error");
		expect(e.enabled).toBe(false);
		expect(e.error).toBeTruthy();
		expect(host.commands).toEqual([]);
		expect(host.actions).toEqual([]);
		expect(host.statuses).toEqual([]);
		expect(styles.size).toBe(0);
		expect(calls.notify.length).toBe(1);
	});

	test("conflict with another extension fails cleanly and keeps the other intact", async () => {
		const { host } = newHost();
		const a = host.install(decl("example.alpha", ["summarize"]));
		await host.enable(a);
		const b = host.install(decl("example.beta", ["other", "summarize"], { theme: THEME }));
		await expect(host.enable(b)).rejects.toThrow();
		expect(host.find(b).state).toBe("error");
		expect(host.find(b).enabled).toBe(false);
		expect(host.commands.map(c => [c.owner, c.name])).toEqual([[a, "summarize"]]);
		expect(styles.size).toBe(0);
		expect(host.find(a).state).toBe("active");
	});

	test("disable removes commands, statuses, actions and theme", async () => {
		const { host } = newHost();
		const { id, runtime } = await activate(host, code("example.dyn", ALL, {
			theme: THEME,
			commands: [{ name: "static", description: "d", template: "t" }],
		}));
		call(host, id, "commands.register", [{ name: "dynamic", description: "d" }, "t1"]);
		call(host, id, "composer.registerAction", [{ id: "act", label: "Act" }, "t2"]);
		call(host, id, "status.set", ["st", "hello"]);
		expect(host.commands.map(c => c.name).sort()).toEqual(["dynamic", "static"]);
		expect(host.actions).toHaveLength(1);
		expect(host.statuses).toHaveLength(1);
		expect(styles.get("--bg")).toBe("#111111");

		host.disable(id);
		expect(host.commands).toEqual([]);
		expect(host.actions).toEqual([]);
		expect(host.statuses).toEqual([]);
		expect(styles.size).toBe(0);
		expect(runtime.stopped).toBe(true);
		expect(host.find(id).state).toBe("disabled");
		expect(host.find(id).enabled).toBe(false);
	});

	test("theme follows the adapter's dark/light preference", async () => {
		const light = newHost({ dark: false });
		await activate(light.host, decl("example.alpha", ["summarize"], { theme: THEME }));
		expect(styles.get("--bg")).toBe("#ffffff");
	});

	test("stale captured template callbacks do not execute after disable or re-enable", async () => {
		const { host, calls } = newHost();
		const id = host.install(decl("example.alpha"));
		await host.enable(id);
		const stale = host.commands[0]!;
		host.disable(id);
		await expect(stale.run("x")).rejects.toThrow();
		expect(calls.prefill).toEqual([]);

		await host.enable(id);
		const fresh = host.commands[0]!;
		await expect(stale.run("x")).rejects.toThrow();
		expect(calls.prefill).toEqual([]);
		await fresh.run("y");
		expect(calls.prefill).toEqual(["Template summarize: y"]);
	});

	test("replacement disables the old version, drops consent, and preserves settings", async () => {
		const { host } = newHost();
		const { id, runtime } = await activate(host, code("example.dyn", ALL, { theme: THEME }));
		call(host, id, "status.set", ["s", "x"]);
		host.setSettings(id, { color: "red", nested: { n: 1 } });

		const sameId = host.install(code("example.dyn", ALL, { theme: THEME, code: "/* changed */" }, ) as never);
		expect(sameId).toBe(id);
		const e = host.find(id);
		expect(e.enabled).toBe(false);
		expect(e.state).toBe("disabled");
		expect(e.package.code).toBe("/* changed */");
		expect(e.settings).toEqual({ color: "red", nested: { n: 1 } });
		expect(runtime.stopped).toBe(true);
		expect(host.statuses).toEqual([]);
		expect(styles.size).toBe(0);
		expect(host.installed).toHaveLength(1);
		// An old runtime's callbacks can no longer reach the host.
		expect(() => runtime.callbacks.request("status.set", ["s", "x"])).toThrow();

		// Consent is persisted as lost: a fresh startup does not re-activate it.
		const again = await reload();
		expect(again.host.installed[0]!.enabled).toBe(false);
		expect(again.host.installed[0]!.settings).toEqual({ color: "red", nested: { n: 1 } });
		expect(again.host.commands).toEqual([]);
		expect(runtimes()).toHaveLength(1);
	});

	test("canResume: only a running same-id package that asks for no new permission", async () => {
		const { host } = newHost();
		const narrow = code("example.dyn", ["status"], { code: "/* v1 */" });
		expect(host.canResume(narrow as never)).toBe(false); // not installed
		const { id } = await activate(host, narrow);
		expect(host.canResume(code("example.dyn", ["status"], { code: "/* v2 */" }) as never)).toBe(true);
		expect(host.canResume(code("example.dyn", [], { code: "/* v2 */" }) as never)).toBe(true); // fewer permissions
		expect(host.canResume(code("example.dyn", ["status", "storage"], { code: "/* v2 */" }) as never)).toBe(false); // new permission
		expect(host.canResume(code("example.other", ["status"]) as never)).toBe(false); // different id
		host.disable(id);
		expect(host.canResume(narrow as never)).toBe(false); // was not running
	});

	test("unsupported permissions and malformed packages are rejected without being installed", () => {
		const { host } = newHost();
		expect(() => host.install(pkg("example.bad", ["network"], { code: "x" }))).toThrow();
		expect(() => host.install(pkg("example.bad", ["commands"], { commands: [{ name: "x", description: "d", template: "t" }] }))).toThrow(); // needs composer
		expect(host.installed).toEqual([]);
		expect(storageKeys().filter(k => k.includes("example.bad"))).toEqual([]);
	});
});

describe("safe mode", () => {
	async function seedEnabled() {
		const first = newHost();
		const id = first.host.install(decl("example.alpha", ["summarize"], { theme: THEME }));
		await first.host.enable(id);
		return { id, ...first };
	}

	test("startup in safe mode bypasses persisted enabled state", async () => {
		const { id, host } = await seedEnabled();
		host.setSafeMode(true);
		const next = await reload();
		expect(next.host.safeMode).toBe(true);
		expect(next.host.installed.map(e => e.package.manifest.id)).toEqual([id]);
		expect(next.host.installed[0]!.state).toBe("disabled");
		expect(next.host.commands).toEqual([]);
		expect(runtimes()).toHaveLength(0);
		await expect(next.host.enable(id)).rejects.toThrow();
		expect(next.host.commands).toEqual([]);
	});

	test("?extensions=off also bypasses and control startup activates enabled extensions", async () => {
		const { id } = await seedEnabled();
		loc.search = "?extensions=off";
		const off = await reload();
		expect(off.host.safeMode).toBe(true);
		expect(off.host.commands).toEqual([]);
		expect(off.host.find(id).state).toBe("disabled");

		loc.search = "";
		styles.clear();
		const on = await reload();
		expect(on.host.safeMode).toBe(false);
		expect(on.host.find(id).state).toBe("active");
		expect(on.host.commands.map(c => c.name)).toEqual(["summarize"]);
		expect(styles.get("--bg")).toBe("#111111");
	});

	test("switching to safe mode tears everything down", async () => {
		const { host } = newHost();
		const { id, runtime } = await activate(host, code("example.dyn", ALL, { theme: THEME }));
		call(host, id, "commands.register", [{ name: "dynamic", description: "d" }, "t1"]);
		call(host, id, "composer.registerAction", [{ id: "act", label: "Act" }, "t2"]);
		call(host, id, "status.set", ["st", "hello"]);
		call(host, id, "events.subscribe");

		host.setSafeMode(true);
		expect(host.safeMode).toBe(true);
		expect(host.commands).toEqual([]);
		expect(host.actions).toEqual([]);
		expect(host.statuses).toEqual([]);
		expect(styles.size).toBe(0);
		expect(runtime.stopped).toBe(true);
		expect(host.find(id).state).toBe("disabled");
		host.emit({ type: "x", at: 1 });
		expect(runtime.events).toEqual([]);
		expect((await reload()).host.safeMode).toBe(true); // persisted
	});

	test("an unfinished boot marker disables only the listed extension and does not enter safe mode", async () => {
		const { id } = await seedEnabled();
		const other = newHost();
		const otherId = other.host.install(decl("example.beta", ["review"]));
		await other.host.enable(otherId);
		storage.set("pipaya.extensions.booting", JSON.stringify([id]));
		const next = await reload();
		expect(next.host.safeMode).toBe(false);
		expect(storage.get("pipaya.extensions.safe")).toBeUndefined();
		expect(next.host.find(id).state).toBe("disabled");
		expect(next.host.find(id).enabled).toBe(false);
		expect(next.host.find(id).error).toBe("시작이 완료되지 않아 비활성화했습니다");
		expect(next.host.find(otherId).state).toBe("active");
		expect(next.host.commands.map(c => c.name)).toEqual(["review"]);
		expect(next.host.loadError).toBe("");
	});

	test("leaving safe mode requires an explicit enable", async () => {
		const { id, host } = await seedEnabled();
		host.setSafeMode(true);
		host.setSafeMode(false);
		await flush();
		expect(host.safeMode).toBe(false);
		expect(host.find(id).state).toBe("disabled");
		expect(host.commands).toEqual([]);
		expect(styles.size).toBe(0);
		expect((await reload()).host.find(id).state).toBe("disabled");
		await host.enable(id);
		expect(host.find(id).state).toBe("active");
		expect(host.commands.map(c => c.name)).toEqual(["summarize"]);
	});
});

describe("capability-checked SDK requests", () => {
	test("every gated method is denied without its permission and has no side effect", async () => {
		const { host, calls } = newHost({ context: () => { throw new Error("context must not be read"); } });
		const { id } = await activate(host, code("example.none", []));
		const denied: [string, unknown[]][] = [
			["commands.register", [{ name: "x", description: "d" }, "tok"]],
			["composer.setText", ["text"]],
			["composer.registerAction", [{ id: "act", label: "A" }, "tok"]],
			["status.set", ["s", "text"]],
			["status.remove", ["s"]],
			["context.get", []],
			["storage.get", ["k"]],
			["storage.set", ["k", "v"]],
			["events.subscribe", []],
			["notifications.show", ["hi"]],
		];
		for (const [method, args] of denied) {
			expect(() => call(host, id, method, args), method).toThrow(/권한|permission/i);
		}
		expect(host.commands).toEqual([]);
		expect(host.actions).toEqual([]);
		expect(host.statuses).toEqual([]);
		expect(calls.prefill).toEqual([]);
		expect(calls.notify).toEqual([]);
		expect(storageKeys().filter(k => k.startsWith("pipaya.extension.storage."))).toEqual([]);
		// Not subscribed, so events are not delivered.
		host.emit({ type: "x", at: 1 });
		expect(runtimes().at(-1)!.events).toEqual([]);
	});

	test("permissions are independent: a granted one does not unlock the others", async () => {
		const { host, calls } = newHost();
		const { id } = await activate(host, code("example.some", ["notifications"]));
		call(host, id, "notifications.show", ["hello"]);
		expect(calls.notify).toEqual(["[Name example.some] hello"]);
		expect(() => call(host, id, "storage.set", ["k", 1])).toThrow(/권한|permission/i);
		expect(() => call(host, id, "composer.setText", ["x"])).toThrow(/권한|permission/i);
		expect(() => call(host, id, "context.get")).toThrow(/권한|permission/i);
	});

	test("notifications are attributed and limited to five per ten seconds", async () => {
		const { host, calls } = newHost();
		const { id } = await activate(host, code("example.notify", ["notifications"]));
		for (let i = 0; i < 5; i++) call(host, id, "notifications.show", ["hello"]);
		expect(calls.notify).toHaveLength(5);
		expect(calls.notify[0]).toBe("[Name example.notify] hello");
		expect(() => call(host, id, "notifications.show", ["spam"])).toThrow();
		expect(calls.notify).toHaveLength(5);
	});

	test("unknown SDK methods are rejected; permissionless settings and log still work", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.none", []));
		expect(() => call(host, id, "process.exit")).toThrow();
		expect(() => call(host, id, "__proto__")).toThrow();
		expect(call(host, id, "settings.get")).toEqual({});
		call(host, id, "log", ["hello"]);
		expect(host.logs.some(l => l.owner === id && l.text === "hello")).toBe(true);
	});

	test("granted composer, notifications and events permissions reach the adapter/runtime", async () => {
		const { host, calls } = newHost();
		const { id, runtime } = await activate(host, code("example.all"));
		call(host, id, "composer.setText", ["draft"]);
		call(host, id, "notifications.show", ["note"]);
		expect(calls.prefill).toEqual(["draft"]);
		expect(calls.notify).toEqual(["[Name example.all] note"]);
		expect(() => call(host, id, "composer.setText", [""])).toThrow();
		expect(() => call(host, id, "composer.setText", ["x".repeat(16001)])).toThrow();
		expect(() => call(host, id, "notifications.show", ["x".repeat(301)])).toThrow();

		host.emit({ type: "before", at: 1 });
		expect(runtime.events).toEqual([]);
		call(host, id, "events.subscribe");
		host.emit({ type: "after", at: 2 });
		expect(runtime.events).toEqual([{ type: "after", at: 2 }]);
		host.disable(id);
		host.emit({ type: "gone", at: 3 });
		expect(runtime.events).toEqual([{ type: "after", at: 2 }]);
	});

	test("context.get returns only the safe fields, never tokens or secrets", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.all"));
		const ctx = call(host, id, "context.get");
		expect(Object.keys(ctx).sort()).toEqual(["language", "model", "online", "provider", "running", "sessionId"]);
		expect(JSON.stringify(ctx)).not.toMatch(/token|secret|password|api.?key/i);
	});

	test("context.get does not leak extra adapter fields such as tokens", async () => {
		const leaky = () => ({ ...CONTEXT, token: "secret-token", apiKey: "sk-123", authorization: "Bearer x" });
		const { host } = newHost({ context: leaky });
		const { id } = await activate(host, code("example.all"));
		const ctx = call(host, id, "context.get");
		expect(JSON.stringify(ctx)).not.toMatch(/secret-token|sk-123|Bearer/);
		expect(Object.keys(ctx).sort()).toEqual(["language", "model", "online", "provider", "running", "sessionId"]);
	});
});

describe("dynamic commands and actions via runtime", () => {
	test("registered commands and actions execute through the runtime with their token", async () => {
		const { host } = newHost();
		const { id, runtime } = await activate(host, code("example.all"));
		call(host, id, "commands.register", [{ name: "deploy", description: "Deploy", args: "[env]" }, "tok-cmd"]);
		call(host, id, "composer.registerAction", [{ id: "act", label: "Action" }, "tok-act"]);
		const cmd = host.commands.find(c => c.name === "deploy")!;
		expect(cmd).toMatchObject({ owner: id, desc: "Deploy", args: "[env]" });
		await cmd.run("prod");
		await host.actions.find(a => a.id === "act")!.run();
		expect(runtime.executed).toEqual([{ token: "tok-cmd", arg: "prod" }, { token: "tok-act", arg: "" }]);
	});

	test("runtime requests through the callback pass the same checks and die with the generation", async () => {
		const { host } = newHost();
		const { id, runtime } = await activate(host, code("example.all"));
		runtime.callbacks.request("status.set", ["st", "ok"]);
		expect(host.statuses.map(s => s.text)).toEqual(["ok"]);
		host.disable(id);
		expect(() => runtime.callbacks.request("status.set", ["st", "again"])).toThrow();
		expect(host.statuses).toEqual([]);
	});

	test("dynamic registration rejects reserved, conflicting, malformed and excess entries", async () => {
		const { host } = newHost();
		const a = await activate(host, code("example.aaa"));
		const b = await activate(host, code("example.bbb"));
		call(host, a.id, "commands.register", [{ name: "mine", description: "d" }, "t"], a.runtime);
		const bad = (name: unknown, runtime = b.runtime, owner = b.id) =>
			expect(() => call(host, owner, "commands.register", [{ name, description: "d" }, "t"], runtime)).toThrow();
		bad("help"); bad("stop"); bad("mine"); bad("Upper"); bad("has space"); bad("");
		expect(() => call(host, b.id, "commands.register", [{ name: "ok", description: "" }, "t"], b.runtime)).toThrow();
		expect(host.commands.map(c => c.name)).toEqual(["mine"]);

		for (let i = 0; i < 20; i++) call(host, b.id, "commands.register", [{ name: `c${i}`, description: "d" }, `t${i}`], b.runtime);
		bad("one-too-many");
		expect(host.commands.filter(c => c.owner === b.id)).toHaveLength(20);
	});

	test("actions reject duplicate ids and cap at ten; statuses update in place and cap at ten", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.all"));
		call(host, id, "composer.registerAction", [{ id: "a0", label: "L" }, "t"]);
		expect(() => call(host, id, "composer.registerAction", [{ id: "a0", label: "L" }, "t"])).toThrow();
		for (let i = 1; i < 10; i++) call(host, id, "composer.registerAction", [{ id: `a${i}`, label: "L" }, "t"]);
		expect(() => call(host, id, "composer.registerAction", [{ id: "a10", label: "L" }, "t"])).toThrow();
		expect(host.actions).toHaveLength(10);

		call(host, id, "status.set", ["s0", "one"]);
		call(host, id, "status.set", ["s0", "two"]);
		expect(host.statuses.map(s => s.text)).toEqual(["two"]);
		for (let i = 1; i < 10; i++) call(host, id, "status.set", [`s${i}`, "x"]);
		expect(() => call(host, id, "status.set", ["s10", "x"])).toThrow();
		call(host, id, "status.remove", ["s0"]);
		expect(host.statuses).toHaveLength(9);
		expect(() => call(host, id, "status.set", ["s11", "x".repeat(121)])).toThrow();
	});

	test("a runtime failure disables the extension and removes everything it registered", async () => {
		const { host, calls } = newHost();
		const { id, runtime } = await activate(host, code("example.dyn", ALL, { theme: THEME }));
		call(host, id, "status.set", ["s", "x"]);
		call(host, id, "commands.register", [{ name: "dynamic", description: "d" }, "t"]);
		runtime.callbacks.failed("boom");
		const e = host.find(id);
		expect(e.state).toBe("error");
		expect(e.enabled).toBe(false);
		expect(e.error).toContain("boom");
		expect(host.commands).toEqual([]);
		expect(host.statuses).toEqual([]);
		expect(styles.size).toBe(0);
		expect(runtime.stopped).toBe(true);
		expect(calls.notify.join()).toContain("boom");
	});

	test("a runtime that fails to start leaves nothing behind", async () => {
		(globalThis as any).__fakeRuntimeStart = async () => { throw new Error("start failed"); };
		const { host } = newHost();
		const id = host.install(code("example.dyn", ALL, { theme: THEME, commands: [{ name: "static", description: "d", template: "t" }] }));
		await expect(host.enable(id)).rejects.toThrow("start failed");
		expect(host.find(id).state).toBe("error");
		expect(host.find(id).enabled).toBe(false);
		expect(host.commands).toEqual([]);
		expect(styles.size).toBe(0);
		expect(runtimes().at(-1)!.stopped).toBe(true);
	});

	test("disabling while a runtime is still starting never activates the extension", async () => {
		let release!: () => void;
		(globalThis as any).__fakeRuntimeStart = () => new Promise<void>(r => { release = r; });
		const { host } = newHost();
		const id = host.install(code("example.dyn", ALL, { theme: THEME }));
		const pending = host.enable(id);
		await flush();
		host.disable(id);
		release();
		await pending;
		expect(host.find(id).state).toBe("disabled");
		expect(host.find(id).enabled).toBe(false);
		expect(styles.size).toBe(0);
		expect(host.commands).toEqual([]);
	});
});

describe("extension storage", () => {
	test("values round trip and are isolated per extension namespace", async () => {
		const { host } = newHost();
		const a = await activate(host, code("example.aaa"));
		const b = await activate(host, code("example.bbb"));
		call(host, a.id, "storage.set", ["k", { n: [1, 2] }], a.runtime);
		expect(call(host, a.id, "storage.get", ["k"], a.runtime)).toEqual({ n: [1, 2] });
		expect(call(host, b.id, "storage.get", ["k"], b.runtime)).toBeNull();
		call(host, b.id, "storage.set", ["k", "b-value"], b.runtime);
		expect(call(host, a.id, "storage.get", ["k"], a.runtime)).toEqual({ n: [1, 2] });
		expect(storageKeys().filter(k => k.includes("example.aaa"))).toHaveLength(1);
		expect(storageKeys().filter(k => k.includes("example.bbb"))).toHaveLength(1);
		call(host, a.id, "storage.set", ["undef", undefined], a.runtime);
		expect(call(host, a.id, "storage.get", ["undef"], a.runtime)).toBeNull();
		expect(call(host, a.id, "storage.get", ["missing"], a.runtime)).toBeNull();
	});

	test("prototype keys are refused and cannot pollute or be read through inheritance", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.all"));
		for (const key of ["__proto__", "constructor", "prototype"]) {
			expect(() => call(host, id, "storage.set", [key, { polluted: true }]), key).toThrow();
		}
		expect(({} as any).polluted).toBeUndefined();
		for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
			expect(call(host, id, "storage.get", [key]), key).toBeNull();
		}
		call(host, id, "storage.set", ["toString", "fine"]);
		expect(call(host, id, "storage.get", ["toString"])).toBe("fine");
	});

	test("invalid keys are rejected", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.all"));
		for (const key of ["", "   ", "k".repeat(81), 1, null, {}]) {
			expect(() => call(host, id, "storage.set", [key, 1]), String(key)).toThrow();
			expect(() => call(host, id, "storage.get", [key]), String(key)).toThrow();
		}
	});

	test("quota is enforced without clobbering what is already stored", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.all"));
		call(host, id, "storage.set", ["small", "keep"]);
		const before = storageKeys().map(k => [k, storage.get(k)]);
		expect(() => call(host, id, "storage.set", ["big", "x".repeat(33000)])).toThrow();
		expect(storageKeys().map(k => [k, storage.get(k)])).toEqual(before);
		expect(call(host, id, "storage.get", ["small"])).toBe("keep");
		expect(call(host, id, "storage.get", ["big"])).toBeNull();
	});

	test("removing an extension deletes its storage", async () => {
		const { host } = newHost();
		const { id } = await activate(host, code("example.all"));
		call(host, id, "storage.set", ["k", "v"]);
		host.remove(id, { keepSettings: false });
		expect(host.installed).toEqual([]);
		expect(storageKeys().filter(k => k.includes("example.all"))).toEqual([]);
	});
});

describe("settings", () => {
	test("settings persist across host instances and are exposed as a copy", async () => {
		const { host } = newHost();
		const id = host.install(code("example.all"));
		host.setSettings(id, { theme: "blue", list: [1, 2], nested: { a: true } });
		const next = await reload();
		const settings = next.host.find(id).settings;
		expect(settings).toEqual({ theme: "blue", list: [1, 2], nested: { a: true } });

		const live = await activate(next.host, code("example.all", ALL, { code: "/* v2 */" }));
		const got = call(next.host, live.id, "settings.get", []);
		expect(got).toEqual(settings);
		got.theme = "mutated";
		expect(next.host.find(id).settings.theme).toBe("blue");
	});

	test("settings must be plain objects within the size limit; failures keep old values", () => {
		const { host } = newHost();
		const id = host.install(code("example.all"));
		host.setSettings(id, { a: 1 });
		for (const bad of [null, [], "str", 1, undefined]) expect(() => host.setSettings(id, bad), String(bad)).toThrow();
		expect(() => host.setSettings(id, { big: "x".repeat(17000) })).toThrow();
		expect(host.find(id).settings).toEqual({ a: 1 });
		expect(() => host.setSettings("example.missing", {})).toThrow();
	});

	test("stored input is detached from the caller's object", () => {
		const { host } = newHost();
		const id = host.install(code("example.all"));
		const input: Record<string, unknown> = { a: { b: 1 } };
		host.setSettings(id, input);
		(input.a as any).b = 2;
		expect(host.find(id).settings).toEqual({ a: { b: 1 } });
	});
});

describe("logs", () => {
	test("log buffer keeps only the newest 100 entries", () => {
		const { host } = newHost();
		for (let i = 0; i < 250; i++) host.log("example.x", `line ${i}`);
		expect(host.logs).toHaveLength(100);
		expect(host.logs[0]!.text).toBe("line 150");
		expect(host.logs.at(-1)!.text).toBe("line 249");
	});

	test("log text is truncated and SDK log requests cannot exceed the cap", async () => {
		const { host } = newHost();
		host.log("example.x", "y".repeat(5000));
		expect(host.logs[0]!.text.length).toBeLessThanOrEqual(1000);
		const { id } = await activate(host, code("example.none", []));
		expect(() => call(host, id, "log", ["z".repeat(1001)])).toThrow();
		expect(() => call(host, id, "log", [""])).toThrow();
		for (let i = 0; i < 150; i++) call(host, id, "log", [`m${i}`]);
		expect(host.logs).toHaveLength(100);
	});

	test("failure messages stored on the extension are bounded", async () => {
		const { host } = newHost();
		const { id, runtime } = await activate(host, code("example.all"));
		runtime.callbacks.failed("e".repeat(5000));
		expect(host.find(id).error!.length).toBeLessThanOrEqual(500);
		expect(host.logs.every(l => l.text.length <= 1000)).toBe(true);
	});
});

describe("navbar and http capabilities", () => {
	const view = (n = 1) => ({ type: "stack", id: "root", direction: "horizontal", children: Array.from({ length: n }, (_, i) => ({
		type: "progress", id: `g${i}`, label: `Item ${i}`, value: 0,
	})) });
	const spec = { label: "Usage", view: view() };
	test("permissions are independent and http.getJson takes exactly one argument and has no default origin", async () => {
		const { host } = newHost();
		const denied = await activate(host, code("example.none", []));
		for (const [method, args] of [["navbar.set", ["usage", spec]], ["navbar.remove", ["usage"]], ["http.getJson", ["/x"]]] as [string, unknown[]][]) {
			expect(() => denied.runtime.callbacks.request(method, args)).toThrow(/권한/);
		}
		const allowed = await activate(host, code("example.generic", ["navbar", "http"]));
		expect(() => allowed.runtime.callbacks.request("http.getJson", [])).toThrow(/한 개/);
		expect(() => allowed.runtime.callbacks.request("http.getJson", ["/x", "extra"])).toThrow(/한 개/);
		expect(() => allowed.runtime.callbacks.request("http.getJson", ["/x"])).toThrow("설정에 httpOrigin이 필요합니다");
		expect(host.navbar).toEqual([]);
	});

	test("navbar items: up to three per extension, replace by id, remove, non-interactive only", async () => {
		const { host } = newHost();
		const a = await activate(host, code("example.a", ["navbar"]));
		const b = await activate(host, code("example.b", ["navbar"]));
		for (const id of ["one", "two", "three"]) a.runtime.callbacks.request("navbar.set", [id, spec]);
		expect(() => a.runtime.callbacks.request("navbar.set", ["four", spec])).toThrow(/최대 3개/);
		a.runtime.callbacks.request("navbar.set", ["two", { ...spec, label: "updated" }]);
		expect(host.navbar.filter(i => i.owner === a.id).map(i => i.label)).toEqual(["Usage", "updated", "Usage"]);
		b.runtime.callbacks.request("navbar.set", ["one", spec]);
		expect(host.navbar).toHaveLength(4);
		expect(() => a.runtime.callbacks.request("navbar.set", ["BAD", spec])).toThrow();
		expect(() => a.runtime.callbacks.request("navbar.set", ["x"])).toThrow(/두 인자/);
		expect(() => a.runtime.callbacks.request("navbar.set", ["x", { ...spec, extra: 1 }])).toThrow();
		expect(() => a.runtime.callbacks.request("navbar.set", ["x", { ...spec, label: "x".repeat(41) }])).toThrow();
		for (const bad of [
			{ type: "button", id: "b", label: "Go" },
			{ type: "form", id: "f", submitLabel: "Go", children: [] },
			{ type: "input", id: "i", label: "In" },
			{ type: "stack", id: "s", children: [{ type: "checkbox", id: "c", label: "C" }] },
		]) expect(() => a.runtime.callbacks.request("navbar.set", ["x", { label: "x", view: bad }])).toThrow(/not allowed|non-interactive/);
		expect(() => a.runtime.callbacks.request("navbar.set", ["x", { label: "x", view: { type: "stack", id: "root", children: [{ type: "stack", id: "a", children: view(40).children }, { type: "stack", id: "b", children: view(40).children.map(c => ({ ...c, id: `${c.id}b` })) }] } }])).toThrow(/at most 60 nodes/);
		a.runtime.callbacks.request("navbar.remove", ["one"]);
		a.runtime.callbacks.request("navbar.remove", ["missing"]);
		expect(host.navbar.filter(i => i.owner === a.id)).toHaveLength(2);
		expect(() => a.runtime.callbacks.request("navbar.remove", [])).toThrow();
		// Stored views are fresh copies.
		const input = { label: "copy", view: view() };
		a.runtime.callbacks.request("navbar.set", ["copy", input]);
		(input.view.children[0] as any).label = "changed";
		expect((host.navbar.find(i => i.id === "copy")!.view as any).children[0].label).toBe("Item 0");
	});

	test("navbar items vanish on disable, reload, failure, safe mode and uninstall", async () => {
		const { host } = newHost();
		const a = await activate(host, code("example.a", ["navbar"]));
		const b = await activate(host, code("example.b", ["navbar"]));
		a.runtime.callbacks.request("navbar.set", ["usage", spec]);
		b.runtime.callbacks.request("navbar.set", ["usage", spec]);
		host.disable(b.id); expect(host.navbar.map(i => i.owner)).toEqual([a.id]);
		await host.enable(b.id);
		runtimes().at(-1)!.callbacks.request("navbar.set", ["usage", spec]);
		host.remove(b.id, { keepSettings: false }); expect(host.navbar.map(i => i.owner)).toEqual([a.id]);
		const old = runtimes().find(r => r.callbacks && !r.stopped)!;
		await host.enable(a.id); expect(host.navbar).toEqual([]);
		expect(() => old.callbacks.request("navbar.set", ["usage", spec])).toThrow();
		const fresh = runtimes().at(-1)!;
		fresh.callbacks.request("navbar.set", ["usage", spec]);
		fresh.callbacks.failed("boom"); expect(host.navbar).toEqual([]);
		await host.enable(a.id);
		runtimes().at(-1)!.callbacks.request("navbar.set", ["usage", spec]);
		host.setSafeMode(true); expect(host.navbar).toEqual([]);
	});

	test("http requests abort on reload and an old response cannot reach the new generation", async () => {
		const original = globalThis.fetch;
		let signal!: AbortSignal;
		let resolve!: (response: Response) => void;
		globalThis.fetch = ((_: unknown, options: RequestInit) => {
			signal = options.signal as AbortSignal;
			return new Promise<Response>(r => { resolve = r; });
		}) as typeof fetch;
		try {
			const { host } = newHost();
			const a = await activate(host, code("example.http", ["http", "navbar"]));
			host.setSettings(a.id, { httpOrigin: "http://localhost:8317" });
			const pending = a.runtime.callbacks.request("http.getJson", ["/data"]) as Promise<unknown>;
			const rejected = expect(pending).rejects.toThrow(/취소/);
			await host.enable(a.id);
			expect(signal.aborted).toBe(true);
			resolve(new Response(JSON.stringify({ ok: true })));
			await rejected;
			expect(() => a.runtime.callbacks.request("navbar.set", ["usage", spec])).toThrow();
			host.stop();
		} finally { globalThis.fetch = original; }
	});

	test("http aborts on safe mode and succeeds with plain JSON", async () => {
		const original = globalThis.fetch;
		const signals: AbortSignal[] = [];
		globalThis.fetch = ((_: unknown, options: RequestInit) => {
			signals.push(options.signal as AbortSignal);
			return Promise.resolve(new Response(JSON.stringify({ a: [1, null] })));
		}) as typeof fetch;
		try {
			const { host } = newHost();
			const a = await activate(host, code("example.http", ["http"]));
			host.setSettings(a.id, { httpOrigin: "https://example.com/" });
			await expect(a.runtime.callbacks.request("http.getJson", ["/one"])).resolves.toEqual({ a: [1, null] });
			const second = a.runtime.callbacks.request("http.getJson", ["/two"]) as Promise<unknown>;
			host.setSafeMode(true);
			await expect(second).rejects.toThrow(/취소/);
			expect(signals[1]!.aborted).toBe(true);
		} finally { globalThis.fetch = original; }
	});
});

describe("generic configuration host capabilities", () => {
	test("background grant gates reads, fingerprints guard apply, code changes stay blocked", async () => {
		const { adapter } = makeAdapter(); let approve: (value: boolean) => void = () => {}, theme = "dark";
		adapter.configuration = { capture: () => ({ servers: [], preferences: { theme: theme as "dark" | "light" } }), apply: d => { theme = d.preferences.theme!; }, backup: () => ({}), restore: () => {}, confirm: () => new Promise(resolve => { approve = resolve; }) };
		const host = new ExtensionHost(); host.init(adapter);
		const sync = await activate(host, code("example.auto", ["configuration", "configuration-background"]));
		try {
			expect(() => call(host, sync.id, "configuration.read")).toThrow("승인");
			call(host, sync.id, "configuration.authorize"); approve(true); await flush();
			expect(call(host, sync.id, "configuration.access").authorized).toBe(true);
			const local = call(host, sync.id, "configuration.read");
			expect(local.fingerprint).toMatch(/^[a-f0-9]{64}$/);
			expect(() => call(host, sync.id, "configuration.applyBackground", [local.document, "stale"])).toThrow("충돌");
			const updated = { ...local.document, preferences: { theme: "light" } };
			call(host, sync.id, "configuration.applyBackground", [updated, local.fingerprint]); expect(theme).toBe("light");
			const now = call(host, sync.id, "configuration.read");
			const unsafe = { ...now.document, extensions: [{ package: code("example.new", []), enabled: false, settings: {} }] };
			expect(() => call(host, sync.id, "configuration.applyBackground", [unsafe, now.fingerprint])).toThrow("수동");
			// Changing the requesting extension's own settings invalidates even an already approved grant.
			await host.setSettings(sync.id, { httpOrigin: "https://changed.test" });
			expect(call(host, sync.id, "configuration.access").authorized).toBe(false);
			call(host, sync.id, "configuration.revoke"); expect(() => call(host, sync.id, "configuration.read")).toThrow("승인");
			call(host, sync.id, "configuration.authorize"); host.disable(sync.id); approve(true); await flush();
			expect(storage.has("pipaya.extensions.background-grant." + sync.id)).toBe(false);
		} finally { host.stop(); }
	});
	test("local-scope credentials never read, migrate, write or delete on working server", async () => {
		const original = globalThis.fetch;
		const requests: { url: string; body?: string }[] = [];
		globalThis.fetch = (async (url, init) => {
			requests.push({ url: String(url), body: init?.body as string | undefined });
			return Response.json({ settings: { "example.local": { httpToken: "remote-secret" } } });
		}) as typeof fetch;
		const pkg = code("example.local", [], { manifest: { id: "example.local", name: "Local", version: "1.0.0", sdkVersion: 1, permissions: [], settingsScope: "local", settings: [{ key: "httpToken", type: "string", label: "Token", secret: true }] } });
		storage.set("pipaya.extensions.v1", JSON.stringify([{ package: pkg, enabled: false, configured: true, settings: { httpToken: "local-secret" } }]));
		const { adapter } = makeAdapter(); adapter.connection = () => ({ baseUrl: "https://work.test", token: "work-token" });
		const host = new ExtensionHost();
		try {
			host.init(adapter); await flush();
			expect(host.find("example.local").settings.httpToken).toBe("local-secret");
			await host.setSettings("example.local", { httpToken: "updated-local-secret" });
			host.remove("example.local", { keepSettings: false }); await flush();
			expect(requests).toHaveLength(1); expect(requests[0]!.url).toContain("/extensions/settings");
		} finally { host.stop(); globalThis.fetch = original; }
	});
	test("configuration and write transport require explicit permissions", async () => {
		const { host } = newHost();
		const a = await activate(host, code("example.no-sync", []));
		for (const method of ["configuration.status", "configuration.export", "configuration.apply", "configuration.restore", "http.requestJson"]) expect(() => call(host, a.id, method)).toThrow("권한 없음");
		host.stop();
	});
	test("approval, disabled package restore, preserved local secrets, backup rollback", async () => {
		const original = globalThis.fetch;
		const { adapter } = makeAdapter();
		let approve: (value: boolean) => void = () => {}, applies = 0;
		adapter.configuration = { capture: () => ({ servers: [], preferences: {} }), apply: () => { applies++; }, backup: () => ({}), restore: () => {}, confirm: () => new Promise(resolve => { approve = resolve; }) };
		const host = new ExtensionHost(); host.init(adapter);
		const active = { id: host.install(code("example.target", [], { manifest: { id: "example.target", name: "Target", version: "1.0.0", sdkVersion: 1, permissions: [], settings: [{ key: "mode", type: "string", label: "Mode" }, { key: "token", type: "string", label: "Token" }] } })) };
		await host.setSettings(active.id, { mode: "before", token: "local-secret" });
		await host.enable(active.id);
		const sync = await activate(host, code("example.backup", ["configuration"]));
		const document = { schemaVersion: 1, servers: [], preferences: {}, extensions: [{ package: { ...host.find(active.id).package, code: "/* new remote code */" }, enabled: true, settings: { mode: "after", token: "remote-secret" } }] };
		globalThis.fetch = (async () => Response.json({ revision: 2, document })) as typeof fetch;
		try {
			expect(() => call(host, sync.id, "configuration.status", ["unexpected"])).toThrow();
			expect(call(host, sync.id, "configuration.apply", [document]).id).toBeDefined();
			expect(applies).toBe(0); approve(true); await flush();
			expect(applies).toBe(1); expect(host.find(active.id).enabled).toBe(false);
			expect(host.find(active.id).settings).toEqual({ mode: "after", token: "local-secret" });
			expect(host.find(active.id).configured).toBe(false);
			expect(host.find(sync.id).state).toBe("active");
			expect(storage.has("pipaya.extensions.configuration-backup")).toBe(true);
			expect(storage.get("pipaya.extensions.settings-source")).toBe("local");
			call(host, sync.id, "configuration.restore"); approve(true); await flush();
			expect(host.find(active.id).settings).toEqual({ mode: "before", token: "local-secret" });
			expect(host.find(active.id).enabled).toBe(false);
			call(host, sync.id, "configuration.apply", [document]); host.disable(sync.id); approve(true); await flush();
			expect(applies).toBe(1); // late approval of a dead generation is ignored
		} finally { host.stop(); globalThis.fetch = original; }
	});
});

describe("server bridge, shortcuts, dialogs, session control and tool renderers", () => {
	const NEW = ["server", "shortcuts", "dialogs", "session", "tools"];

	test("every new capability is refused without its permission", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.bare", ["commands"]));
		const calls: [string, unknown[]][] = [
			["server.call", ["ext", "m", null, null]], ["server.entries", [{}]], ["server.list", []], ["server.subscribe", []],
			["shortcuts.register", [{ id: "a", label: "A", combo: "Mod+K" }, "t"]], ["shortcuts.remove", ["a"]],
			["dialog.confirm", [{ title: "t" }]], ["session.send", ["hi"]], ["session.abort", []],
			["tools.registerRenderer", ["bash", "t"]], ["tools.removeRenderer", ["bash"]],
			["panes.list", []], ["panes.send", ["s1", "hi"]], ["panes.close", ["s1"]], ["panes.models", []], ["panes.configure", ["s1", { title: "x" }]], ["panes.compact", ["s1"]],
		];
		for (const [method, args] of calls) expect(() => call(host, id, method, args)).toThrow(/권한 없음|permission/i);
		host.stop();
	});

	test("shortcuts need Ctrl/Alt and one key, cannot clash, and only fire while the extension is active", async () => {
		const { host } = await reload();
		const a = await activate(host, code("example.keys-a", NEW));
		const spec = (id: string, combo: string) => [{ id, label: id, combo }, "tok"];
		expect(() => call(host, a.id, "shortcuts.register", spec("plain", "K"))).toThrow();
		expect(() => call(host, a.id, "shortcuts.register", spec("shift", "Shift+K"))).toThrow();
		expect(() => call(host, a.id, "shortcuts.register", spec("two", "Mod+J+K"))).toThrow();
		call(host, a.id, "shortcuts.register", spec("ok", "Mod+Shift+K"));
		expect(() => call(host, a.id, "shortcuts.register", spec("again", "Mod+Shift+K"))).toThrow(/Mod\+Shift\+K/);
		const b = await activate(host, code("example.keys-b", NEW));
		expect(() => call(host, b.id, "shortcuts.register", spec("steal", "Mod+Shift+K"))).toThrow();
		expect(host.shortcutFor("Mod+Shift+K")?.owner).toBe("example.keys-a");
		await host.shortcutFor("Mod+Shift+K")!.run();
		expect(runtimes()[0]!.executed.length).toBe(1);
		host.disable(a.id);
		expect(host.shortcutFor("Mod+Shift+K")).toBeUndefined();
		host.stop();
	});

	test("dialogs are validated, attributed to the extension, and answered through the adapter", async () => {
		const { host, adapter } = newHost();
		await flush();
		const seen: any[] = [];
		adapter.dialog = async request => { seen.push(request); return request.kind === "confirm" ? true : request.kind === "select" ? request.options[1]!.value : "typed"; };
		const { id } = await activate(host, code("example.ask", NEW));
		expect(await call(host, id, "dialog.confirm", [{ title: "Sure?", message: "m" }])).toBe(true);
		expect(await call(host, id, "dialog.select", [{ title: "Pick", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }])).toBe("b");
		expect(await call(host, id, "dialog.input", [{ title: "Name", placeholder: "p" }])).toBe("typed");
		expect(seen.map(r => r.kind)).toEqual(["confirm", "select", "input"]);
		expect(seen.every(r => r.owner === id && r.ownerName === `Name ${id}`)).toBe(true);
		expect(() => call(host, id, "dialog.select", [{ title: "Pick", options: [] }])).toThrow();
		expect(() => call(host, id, "dialog.confirm", [{ title: "" }])).toThrow();
		host.stop();
	});

	test("an answer that arrives after the extension was disabled is dropped", async () => {
		const { host, adapter } = newHost();
		await flush();
		let answer: (v: unknown) => void = () => {};
		adapter.dialog = () => new Promise(resolve => { answer = resolve; });
		const { id } = await activate(host, code("example.late", NEW));
		const pending = call(host, id, "dialog.confirm", [{ title: "Sure?" }]);
		host.disable(id);
		answer(true);
		expect(await pending).toBe(false);
		host.stop();
	});

	test("session control goes through the adapter and is rate limited", async () => {
		const { host, adapter } = newHost();
		await flush();
		const sent: string[] = []; let aborted = 0;
		adapter.session = { send: async (text, mode) => { sent.push(`${mode}:${text}`); }, abort: async () => { aborted++; } };
		const { id } = await activate(host, code("example.drive", NEW));
		await call(host, id, "session.send", ["hello"]);
		await call(host, id, "session.send", ["more", "steer"]);
		await call(host, id, "session.send", ["x", "bogus-mode"]);
		await call(host, id, "session.abort", []);
		expect(sent).toEqual(["prompt:hello", "steer:more", "prompt:x"]);
		expect(aborted).toBe(1);
		await call(host, id, "session.abort", []);
		expect(() => call(host, id, "session.abort", [])).toThrow(/5/);
		host.stop();
	});

	test("tool renderers return validated views only, replace by tool name, and leave with the extension", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.render", NEW));
		call(host, id, "tools.registerRenderer", ["bash", "tok-1"]);
		expect(() => call(host, id, "tools.registerRenderer", ["bad name", "tok-2"])).toThrow();
		const view = { type: "text", id: "t", text: "custom" };
		(globalThis as any).__fakeReturn = { "tok-1": view };
		const input = { toolName: "bash", state: "done" as const, args: {}, output: "o", details: null };
		expect(await host.rendererFor("bash")!.render(input)).toEqual(view);
		(globalThis as any).__fakeReturn = { "tok-1": { type: "script", src: "x" } };
		await expect(host.rendererFor("bash")!.render(input)).rejects.toThrow();
		(globalThis as any).__fakeReturn = { "tok-1": null };
		expect(await host.rendererFor("bash")!.render(input)).toBeNull();
		expect(host.rendererFor("read")).toBeUndefined();
		host.disable(id);
		expect(host.rendererFor("bash")).toBeUndefined();
		delete (globalThis as any).__fakeReturn;
		host.stop();
	});

	test("server events reach only extensions that subscribed with the server permission", async () => {
		const { host } = await reload();
		const sub = await activate(host, code("example.sub", NEW));
		const other = await activate(host, code("example.other", NEW));
		call(host, sub.id, "server.subscribe", []);
		host.emitServer({ kind: "event", extension: "demo", type: "x", sessionId: null, data: 1 });
		expect((sub.runtime as any).serverEvents).toEqual([{ kind: "event", extension: "demo", type: "x", sessionId: null, data: 1 }]);
		expect((other.runtime as any).serverEvents).toBeUndefined();
		host.stop();
	});

	test("turn_end and tool_execution_end reach event subscribers with only metadata", async () => {
		const { host } = await reload();
		const { id, runtime } = await activate(host, code("example.watch", ["events"]));
		call(host, id, "events.subscribe", []);
		host.emit({ type: "tool_execution_end", sessionId: "s1", at: 5, toolName: "bash", isError: true });
		host.emit({ type: "turn_end", sessionId: "s1", at: 6 });
		expect(runtime.events).toEqual([
			{ type: "tool_execution_end", sessionId: "s1", at: 5, toolName: "bash", isError: true },
			{ type: "turn_end", sessionId: "s1", at: 6 },
		]);
		host.stop();
	});
});

describe("session labels, mentions and sender rules", () => {
	test("each capability is refused without its permission", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.bare3", ["commands"]));
		for (const [m, a] of [["sessionLabels.set", [{}]], ["mentions.set", [[]]], ["messages.setHeader", ["^x"]], ["messages.clearHeader", []]] as [string, unknown[]][]) {
			expect(() => call(host, id, m, a)).toThrow(/권한 없음|permission/i);
		}
		host.stop();
	});

	test("labels, mentions and senders come from the active extension only", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.peer", ["session-labels", "composer-mentions", "messages"]));
		call(host, id, "sessionLabels.set", [{ s1: { text: "@미나", title: "미나" }, s2: { text: " " }, s3: 1 }]);
		expect(host.labelOf("s1")).toEqual({ text: "@미나", title: "미나" });
		expect(host.labelOf("s2")).toBeUndefined();
		call(host, id, "mentions.set", [[{ insert: "@미나", desc: "docs", group: "세션" }, { insert: "no-at" }, { insert: "@a b" }]]);
		expect(host.mentions().map((m) => m.insert)).toEqual(["@미나"]);
		expect(host.headerOf("[from @지우] hi")).toBeNull();
		call(host, id, "messages.setHeader", ["^\\[from (@[^,\\]]+)\\]"]);
		expect(host.headerOf("[from @지우]\n안녕")).toEqual({ from: "@지우", body: "안녕" });
		expect(host.headerOf("hello")).toBeNull();
		expect(() => call(host, id, "messages.setHeader", ["("])).toThrow();
		host.disable(id);
		expect(host.labelOf("s1")).toBeUndefined();
		expect(host.mentions()).toEqual([]);
		expect(host.headerOf("[from @지우]\n안녕")).toBeNull();
		host.stop();
	});
});

describe("message renderers, slots and the composer filter", () => {
	const NEW = ["messages", "slots", "composer-filter"];
	const view = { type: "text", id: "t", text: "hi" };

	test("each capability is refused without its permission", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.bare2", ["commands"]));
		for (const [m, a] of [["messages.registerRenderer", ["todo", "t"]], ["slots.set", ["footer", "a", { label: "L", view }]], ["composerFilter.set", ["filter", "t"]], ["composerFilter.clear", []]] as [string, unknown[]][]) {
			expect(() => call(host, id, m, a)).toThrow(/권한 없음|permission/i);
		}
		host.stop();
	});

	test("message renderers draw only data-only nodes and leave with the extension", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.msg", NEW));
		call(host, id, "messages.registerRenderer", ["todo", "tok"]);
		expect(() => call(host, id, "messages.registerRenderer", ["bad type", "tok"])).toThrow();
		const entry = { id: 1, extension: "demo", type: "todo", data: {}, createdAt: 1 };
		(globalThis as any).__fakeReturn = { tok: view };
		expect(await host.messageRendererFor("todo")!.render(entry)).toEqual(view);
		(globalThis as any).__fakeReturn = { tok: { type: "button", id: "b", label: "x" } }; // interactive: not allowed in a transcript
		await expect(host.messageRendererFor("todo")!.render(entry)).rejects.toThrow();
		expect(host.messageRendererFor("other")).toBeUndefined();
		host.disable(id);
		expect(host.messageRendererFor("todo")).toBeUndefined();
		delete (globalThis as any).__fakeReturn;
		host.stop();
	});

	test("slots take read-only views, two per extension, and are removed with the extension", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.slot", NEW));
		call(host, id, "slots.set", ["header", "a", { label: "A", view }]);
		call(host, id, "slots.set", ["footer", "b", { label: "B", view }]);
		call(host, id, "slots.set", ["footer", "b", { label: "B2", view }]); // same slot+id replaces
		expect(host.slots.length).toBe(2);
		expect(() => call(host, id, "slots.set", ["footer", "c", { label: "C", view }])).toThrow(/2/);
		expect(() => call(host, id, "slots.set", ["sidebar", "d", { label: "D", view }])).toThrow();
		expect(() => call(host, id, "slots.set", ["header", "e", { label: "E", view: { type: "button", id: "b", label: "x" } }])).toThrow();
		call(host, id, "slots.remove", ["header", "a"]);
		expect(host.slots.map(s => `${s.slot}:${s.id}:${s.label}`)).toEqual(["footer:b:B2"]);
		host.disable(id);
		expect(host.slots).toEqual([]);
		host.stop();
	});

	test("the composer filter rewrites, cancels, is skipped when it fails, and stops with the extension", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.filter", NEW));
		call(host, id, "composerFilter.set", ["filter", "tok"]);
		(globalThis as any).__fakeReturn = { tok: "rewritten" };
		expect(await host.filterComposer("orig")).toEqual({ text: "rewritten" });
		(globalThis as any).__fakeReturn = { tok: { text: "obj" } };
		expect(await host.filterComposer("orig")).toEqual({ text: "obj" });
		(globalThis as any).__fakeReturn = { tok: { cancel: "no secrets" } };
		expect(await host.filterComposer("orig")).toEqual({ cancel: `[Name ${id}] no secrets` });
		(globalThis as any).__fakeReturn = { tok: 42 }; // not a usable answer: send as is
		expect(await host.filterComposer("orig")).toEqual({ text: "orig" });
		call(host, id, "composerFilter.clear", []);
		(globalThis as any).__fakeReturn = { tok: "rewritten" };
		expect(await host.filterComposer("orig")).toEqual({ text: "orig" });
		call(host, id, "composerFilter.set", ["filter", "tok"]);
		host.disable(id);
		expect(await host.filterComposer("orig")).toEqual({ text: "orig" });
		delete (globalThis as any).__fakeReturn;
		host.stop();
	});
});

describe("panes", () => {
	function fakePanes() {
		const log: unknown[][] = [];
		const rec = (name: string, value: unknown = undefined) => async (...a: unknown[]) => { log.push([name, ...a]); return value as any; };
		const panes = {
			list: () => [{ id: "s1", kind: "session", title: "t", cwd: "/", focused: true, running: false, awaitingApproval: 0, model: "m", provider: "p", groupId: null, box: { x: 0, y: 0, w: 1, h: 1 } }],
			group: () => null,
			read: rec("read", [{ role: "user", text: "hi", at: 1 }]),
			focus: rec("focus"), send: rec("send"), abort: rec("abort"), split: rec("split", "s2"), move: rec("move"), swap: rec("swap"),
			resize: rec("resize"), leave: rec("leave"), close: rec("close"), zoom: rec("zoom"),
			models: () => [{ provider: "p", id: "m", name: "M", reasoning: true, thinkingLevels: null, vision: false, contextWindow: 1 }],
			configure: rec("configure"), compact: rec("compact"),
			groups: () => [{ id: "g1", name: "G", layout: { type: "pane", sessionId: "s1" }, paneIds: ["s1"], open: true, full: false }],
			openGroup: rec("openGroup"), createGroup: rec("createGroup", "g2"), setLayout: rec("setLayout"), renameGroup: rec("renameGroup"),
			deleteGroup: rec("deleteGroup"), setFull: rec("setFull"),
		};
		return { panes: panes as any, log };
	}
	async function setup() {
		const f = fakePanes();
		const r = await reload();
		(r.adapter as any).panes = f.panes;
		const { id } = await activate(r.host, code("example.orchestrator", ["panes"]));
		return { ...r, ...f, id };
	}

	test("reads are plain data and writes reach the adapter with validated arguments", async () => {
		const { host, id, log } = await setup();
		expect(await call(host, id, "panes.list")).toHaveLength(1);
		expect(await call(host, id, "panes.group")).toBeNull();
		expect(await call(host, id, "panes.read", ["s1", { limit: 5 }])).toEqual([{ role: "user", text: "hi", at: 1 }]);
		await call(host, id, "panes.send", ["s1", "go"]);
		await call(host, id, "panes.send", ["s1", "later", "follow_up"]);
		expect(await call(host, id, "panes.split", ["s1", "right", { kind: "terminal" }])).toEqual({ id: "s2" });
		await call(host, id, "panes.resize", ["s1", 0.3]);
		await call(host, id, "panes.zoom", [null]);
		expect(log).toEqual([
			["read", "s1", 5], ["send", "s1", "go", "prompt"], ["send", "s1", "later", "follow_up"],
			["split", "s1", "right", "terminal", false], ["resize", "s1", 0.3], ["zoom", null],
		]);
		host.stop();
	});

	test("settings: only known fields reach the adapter, and the models list is plain data", async () => {
		const { host, id, log } = await setup();
		expect(await call(host, id, "panes.models")).toHaveLength(1);
		await call(host, id, "panes.configure", ["s1", { provider: "p", model: "m", thinkingLevel: "high", title: "T" }]);
		await call(host, id, "panes.compact", ["s1", "keep the plan"]);
		await call(host, id, "panes.compact", ["s1"]);
		expect(log).toEqual([
			["configure", "s1", { title: "T", provider: "p", model: "m", thinkingLevel: "high" }],
			["compact", "s1", "keep the plan"], ["compact", "s1", undefined],
		]);
		for (const bad of [{}, { token: "x" }, { thinkingLevel: "extreme" }, { approval: "ask" }, { title: "" }])
			await expect(Promise.resolve().then(() => call(host, id, "panes.configure", ["s1", bad]))).rejects.toThrow();
		expect(log).toHaveLength(3);
		host.stop();
	});

	test("bad arguments are refused before they reach the adapter", async () => {
		const { host, id, log } = await setup();
		for (const [m, a] of [
			["panes.send", ["s1", "x", "shout"]], ["panes.send", ["s1", ""]], ["panes.split", ["s1", "middle"]],
			["panes.split", ["s1", "left", { kind: "window" }]], ["panes.resize", ["s1", 0.95]], ["panes.resize", ["s1", "a"]],
			["panes.read", ["s1", { limit: 101 }]], ["panes.move", ["s1", "s2", "up"]], ["panes.focus", [7]],
		] as [string, unknown[]][]) await expect(Promise.resolve().then(() => call(host, id, m, a))).rejects.toThrow();
		expect(log).toEqual([]);
		host.stop();
	});

	test("changes are limited to 30 per 10 seconds, reads are not", async () => {
		const { host, id } = await setup();
		for (let i = 0; i < 30; i++) await call(host, id, "panes.focus", ["s1"]);
		await expect(Promise.resolve().then(() => call(host, id, "panes.focus", ["s1"]))).rejects.toThrow(/30/);
		expect(await call(host, id, "panes.list")).toHaveLength(1);
		host.stop();
	});

	test("groups: layouts are validated into fresh trees before they reach the adapter", async () => {
		const { host, id, log } = await setup();
		expect(await call(host, id, "panes.groups")).toHaveLength(1);
		const layout = { type: "split", dir: "row", a: { type: "pane", id: "s1" }, b: { type: "split", dir: "col", ratio: 0.3, a: { type: "pane", sessionId: "s2" }, b: { type: "pane", id: "term_1" } } };
		expect(await call(host, id, "panes.createGroup", [layout, "Trio"])).toEqual({ id: "g2" });
		await call(host, id, "panes.setLayout", ["g1", layout]);
		await call(host, id, "panes.openGroup", ["g1"]);
		await call(host, id, "panes.renameGroup", ["g1", "New"]);
		await call(host, id, "panes.full", ["g1", true]);
		await call(host, id, "panes.deleteGroup", ["g1"]);
		const tree = { type: "split", dir: "row", ratio: 0.5, a: { type: "pane", sessionId: "s1" }, b: { type: "split", dir: "col", ratio: 0.3, a: { type: "pane", sessionId: "s2" }, b: { type: "pane", sessionId: "term_1" } } };
		expect(log).toEqual([["createGroup", tree, "Trio"], ["setLayout", "g1", tree], ["openGroup", "g1"], ["renameGroup", "g1", "New"], ["setFull", "g1", true], ["deleteGroup", "g1"]]);
		const pane = (id: string) => ({ type: "pane", id });
		for (const bad of [
			pane("s1"),
			{ type: "split", dir: "row", a: pane("s1"), b: pane("s1") },
			{ type: "split", dir: "diag", a: pane("s1"), b: pane("s2") },
			{ type: "split", dir: "row", ratio: 0.95, a: pane("s1"), b: pane("s2") },
			{ type: "split", dir: "row", a: pane("s1"), b: { type: "frame" } },
		]) await expect(Promise.resolve().then(() => call(host, id, "panes.createGroup", [bad]))).rejects.toThrow();
		await expect(Promise.resolve().then(() => call(host, id, "panes.full", ["g1", "yes"]))).rejects.toThrow();
		expect(log).toHaveLength(6);
		host.stop();
	});

	test("a client without pane support says so", async () => {
		const { host } = await reload();
		const { id } = await activate(host, code("example.nopanes", ["panes"]));
		expect(() => call(host, id, "panes.list")).toThrow();
		host.stop();
	});
});

describe("workspace", () => {
	async function setup(permissions = ["workspace"]) {
		const log: unknown[][] = [];
		const ws = {
			state: () => ({ narrow: false, sidebar: { open: false, collapsed: false, width: 288, minWidth: 220, maxWidth: 560 }, folder: "/w", tabs: [], settingsOpen: false }),
			sidebar: (c: unknown) => { log.push(["sidebar", c]); },
			openTab: async (x: string) => { log.push(["openTab", x]); },
			moveTab: (a: string, b: string, after: boolean) => { log.push(["moveTab", a, b, after]); },
			openSettings: (x: string) => { log.push(["openSettings", x]); },
			closeSettings: () => { log.push(["closeSettings"]); },
			open: (x: string) => { log.push(["open", x]); },
			runCommand: async (n: string, a: string) => { log.push(["run", n, a]); },
			commands: () => ["new", "compact"],
		};
		const r = await reload();
		(r.adapter as any).workspace = ws;
		const { id } = await activate(r.host, code("example.layout", permissions));
		return { ...r, id, log };
	}
	test("needs the workspace permission", async () => {
		const { host, id } = await setup(["commands"]);
		for (const m of ["workspace.state", "workspace.sidebar", "workspace.runCommand"]) expect(() => call(host, id, m, [{}])).toThrow(/권한 없음|permission/i);
		host.stop();
	});
	test("validated calls reach the adapter; bad ones never do", async () => {
		const { host, id, log } = await setup();
		expect((await call(host, id, "workspace.state")).folder).toBe("/w");
		expect(await call(host, id, "workspace.commands")).toEqual(["new", "compact"]);
		await call(host, id, "workspace.sidebar", [{ collapsed: true, width: 300 }]);
		await call(host, id, "workspace.openTab", ["g1"]);
		await call(host, id, "workspace.moveTab", ["a", "b", "after"]);
		await call(host, id, "workspace.openSettings", ["extensions"]);
		await call(host, id, "workspace.closeSettings", []);
		await call(host, id, "workspace.open", ["skills"]);
		await call(host, id, "workspace.runCommand", ["compact", "keep it"]);
		expect(log).toEqual([["sidebar", { collapsed: true, width: 300 }], ["openTab", "g1"], ["moveTab", "a", "b", true], ["openSettings", "extensions"], ["closeSettings"], ["open", "skills"], ["run", "compact", "keep it"]]);
		for (const [m, a] of [
			["workspace.sidebar", [{ hidden: true }]], ["workspace.sidebar", [{ open: "yes" }]], ["workspace.moveTab", ["a", "b", "inside"]],
			["workspace.openSettings", ["secrets"]], ["workspace.open", ["terminal"]], ["workspace.runCommand", ["Bad Name"]],
		] as [string, unknown[]][]) await expect(Promise.resolve().then(() => call(host, id, m, a))).rejects.toThrow();
		expect(log).toHaveLength(7);
		host.stop();
	});
});

describe("trusted UI (ui-style / ui-components)", () => {
	const ui = (id: string, extra: Record<string, unknown> = {}, permissions = ["ui-components", "ui-style"]) =>
		pkg(id, permissions, { components: { Chip: "<p/>", Send: "<p/>" }, mounts: [{ slot: "header.end", component: "Chip" }, { slot: "header.end", component: "Chip", order: -1 }], replaces: { "composer.send": "Send" }, styles: "[data-part='header']{height:60px}", ...extra });

	test("nothing is mounted or injected until the extension is enabled", () => {
		const { host } = newHost();
		host.install(ui("example.skin"));
		expect(host.mountsIn("header.end")).toEqual([]);
		expect(host.replacementFor("composer.send")).toBeUndefined();
		expect(styleEls).toHaveLength(0);
	});
	test("enable mounts in order, replaces the part and injects the stylesheet", async () => {
		const { host } = newHost();
		const { id } = await activate(host, ui("example.skin"));
		expect(host.mountsIn("header.end").map(m => m.order)).toEqual([-1, 0]);
		expect(host.mountsIn("header.start")).toEqual([]);
		expect(host.replacementFor("composer.send")?.owner).toBe(id);
		expect(styleEls).toHaveLength(1);
		expect(styleEls[0]!.dataset.extension).toBe(id);
		expect(styleEls[0]!.textContent).toContain("height:60px");
	});
	test("disable removes everything the extension added, and leaves other extensions alone", async () => {
		const { host } = newHost();
		const a = await activate(host, ui("example.skin"));
		const { styles: _s, ...noStyles } = ui("example.other", {}, ["ui-components"]) as Record<string, unknown>;
		const b = await activate(host, noStyles as never);
		expect(host.mountsIn("header.end")).toHaveLength(4);
		host.disable(a.id);
		expect(styleEls[0]!.removed).toBe(true);
		expect(host.mountsIn("header.end").map(m => m.owner)).toEqual([b.id, b.id]);
		expect(host.replacementFor("composer.send")?.owner).toBe(b.id);
	});
	test("the stylesheet gets the package's design files inlined; components get them as ext.assets", async () => {
		const png = "data:image/png;base64,iVBORw0KGgo=";
		const { host } = newHost();
		await activate(host, ui("example.skin", { assets: { "logo.png": png }, styles: `[data-part='sidebar.brand']{background:asset("logo.png")}` }));
		expect(styleEls[0]!.textContent).toBe(`[data-part='sidebar.brand']{background:url("${png}")}`);
	});
	test("mounts are grouped per slot and follow the extension's state", async () => {
		const { host } = newHost();
		const { id } = await activate(host, ui("example.skin"));
		const first = host.mountsIn("header.end");
		expect(host.mountsIn("header.end")).toBe(first); // same list while nothing changed: slots do not re-render
		host.disable(id);
		expect(host.mountsIn("header.end")).toEqual([]);
	});
	test("safe mode shows none of it", async () => {
		const { host } = newHost();
		await activate(host, ui("example.skin"));
		host.setSafeMode(true);
		expect(host.mountsIn("header.end")).toEqual([]);
		expect(host.replacementFor("composer.send")).toBeUndefined();
		expect(styleEls[0]!.removed).toBe(true);
	});
	test("a component that fails to compile stops the extension and cleans up", async () => {
		const { host } = newHost();
		(globalThis as any).__componentsError = "Chip.svelte: boom";
		const id = host.install(ui("example.skin"));
		await expect(host.enable(id)).rejects.toThrow("boom");
		expect(host.find(id).state).toBe("error");
		expect(host.mountsIn("header.end")).toEqual([]);
		expect(styleEls.every(e => e.removed)).toBe(true);
	});
	test("without the permission the package cannot even be installed", () => {
		const { host } = newHost();
		expect(() => host.install(ui("example.skin", {}, ["ui-style"]))).toThrow(/ui-components/);
		expect(() => host.install(ui("example.skin", {}, ["ui-components"]))).toThrow(/ui-style/);
	});
	test("components.setData needs ui-components, is bounded and is dropped with the extension", async () => {
		const { host } = newHost();
		const plain = await activate(host, code("example.plain", ["ui"]));
		expect(() => call(host, plain.id, "components.setData", [1])).toThrow(/권한|permission/i);
		const { id } = await activate(host, ui("example.skin", { code: "/* fake */" }));
		call(host, id, "components.setData", [{ n: 1 }]);
		expect(host.componentData[id]).toEqual({ n: 1 });
		expect(() => call(host, id, "components.setData", ["x".repeat(65000)])).toThrow();
		expect(() => call(host, id, "components.setData", [])).toThrow();
		host.disable(id);
		expect(host.componentData[id]).toBeUndefined();
	});
	test("an upgrade that asks for ui-components needs consent again", async () => {
		const { host } = newHost();
		await activate(host, code("example.skin", ["ui"]));
		expect(host.canResume(ui("example.skin") as never)).toBe(false);
	});
});
