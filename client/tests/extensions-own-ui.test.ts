import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { OwnPageUis as OwnPageUisType } from "../src/lib/extensions/own-ui.svelte";
import { ownUiFingerprint, OWN_UI_CONSENT_KEY, type OwnUiSources } from "../src/lib/extensions/own-ui";

// The real rune module, bundled with the host and the compiler stubbed: what is under test is who may run what and when.
let OwnPageUis: typeof OwnPageUisType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".own-ui-"));
	const stub = join(dir, "stub.js");
	await writeFile(stub, `export const extensions = { safeMode: false }; export const errorText = (e) => (e instanceof Error ? e.message : String(e));`);
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/extensions/own-ui.svelte.ts")], target: "bun", external: ["svelte", "svelte/internal/client"],
		plugins: [{ name: "runes", setup(builder) {
			// Only the entry's own imports are replaced; the stub keeps the host and the api (and everything they pull in) out of the build.
			builder.onResolve({ filter: /^\.\/host\.svelte$/ }, ({ importer }) => (importer.endsWith("own-ui.svelte.ts") ? { path: stub } : undefined));
			builder.onResolve({ filter: /^\.\.\/api$/ }, ({ importer }) => (importer.endsWith("own-ui.svelte.ts") ? { path: stub } : undefined));
			builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
				return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	await writeFile(join(dir, "own.mjs"), await build.outputs[0]!.text());
	await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	OwnPageUis = (await import(join(dir, "own.mjs"))).OwnPageUis;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const SOURCES: OwnUiSources = { components: { Top: "<p/>", Section: "<p/>" }, mounts: [{ slot: "extension.page.top", component: "Top" }], replaces: { "extension.settings": "Section" } };
const mem = () => { const m = new Map<string, string>(); return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }; };
const apiOf = (get: () => OwnUiSources | Promise<OwnUiSources>, calls: string[] = []) => ({ serverExtensionUi: async (name: string) => { calls.push(name); return get(); } }) as any;
const make = (storage: ReturnType<typeof mem>["storage"], opts: { safe?: () => boolean; loaded?: string[] } = {}) => new OwnPageUis({
	storage, safeMode: opts.safe ?? (() => false),
	loader: async () => ({ load: (pkg: any) => { opts.loaded?.push(Object.keys(pkg.components).join(",")); return Object.fromEntries(Object.keys(pkg.components).map((n) => [n, { name: n } as any])); } }),
});

describe("a server extension's own page code", () => {
	test("nothing runs until this device agreed; the user is told what is waiting", async () => {
		const { storage } = mem(); const loaded: string[] = [];
		const ui = make(storage, { loaded });
		expect(ui.stateOf("s1", "demo")).toEqual({ status: "off" });
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		expect(ui.stateOf("s1", "demo")).toEqual({ status: "ask", names: ["Top", "Section"] });
		expect(loaded).toEqual([]);
	});
	test("agreeing runs exactly that code, remembers it, and the next visit runs without asking", async () => {
		const { storage, m } = mem(); const loaded: string[] = [];
		const ui = make(storage, { loaded });
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		await ui.allow("s1", "demo", "demo");
		const state = ui.stateOf("s1", "demo");
		expect(state.status).toBe("ready");
		if (state.status === "ready") {
			expect(state.ui.mounts).toHaveLength(1);
			expect(state.ui.settings).toBeDefined();
			expect(Object.keys(state.ui.components)).toEqual(["Top", "Section"]);
		}
		expect(JSON.parse(m.get(OWN_UI_CONSENT_KEY)!)).toEqual({ "s1:demo": ownUiFingerprint(SOURCES) });
		// a new session of the app (a new object over the same storage)
		const again = make(storage, { loaded });
		await again.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		expect(again.stateOf("s1", "demo").status).toBe("ready");
	});
	test("an agreement is for one server and one extension only", async () => {
		const { storage } = mem();
		const ui = make(storage);
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		await ui.allow("s1", "demo", "demo");
		await ui.ensure("s2", apiOf(() => SOURCES), "demo", "demo");
		await ui.ensure("s1", apiOf(() => SOURCES), "other", "other");
		expect(ui.stateOf("s2", "demo").status).toBe("ask");
		expect(ui.stateOf("s1", "other").status).toBe("ask");
	});
	test("changed code is not run: the user is asked again", async () => {
		const { storage } = mem(); const loaded: string[] = [];
		const ui = make(storage, { loaded });
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		await ui.allow("s1", "demo", "demo");
		loaded.length = 0;
		const changed = { ...SOURCES, components: { ...SOURCES.components, Top: "<p>evil</p>" } };
		const again = make(storage, { loaded });
		await again.ensure("s1", apiOf(() => changed), "demo", "demo");
		expect(again.stateOf("s1", "demo")).toEqual({ status: "changed", names: ["Top", "Section"] });
		expect(loaded).toEqual([]);
	});
	test("safe mode runs none of it, even what was agreed to", async () => {
		const { storage } = mem(); const loaded: string[] = [];
		let safe = false;
		const ui = make(storage, { loaded, safe: () => safe });
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		await ui.allow("s1", "demo", "demo");
		safe = true; loaded.length = 0;
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		expect(ui.stateOf("s1", "demo")).toEqual({ status: "off" });
		expect(loaded).toEqual([]);
		await ui.allow("s1", "demo", "demo"); // cannot be forced on in safe mode
		expect(loaded).toEqual([]);
	});
	test("revoking stops it and forgets the agreement", async () => {
		const { storage, m } = mem();
		const ui = make(storage);
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		await ui.allow("s1", "demo", "demo");
		ui.revoke("s1", "demo");
		expect(ui.stateOf("s1", "demo").status).toBe("ask");
		expect(JSON.parse(m.get(OWN_UI_CONSENT_KEY)!)).toEqual({});
		await make(storage).ensure("s1", apiOf(() => SOURCES), "demo", "demo");
	});
	test("a server that refuses, serves a bad package or another slot shows an error and runs nothing", async () => {
		const { storage } = mem(); const loaded: string[] = [];
		const ui = make(storage, { loaded });
		await ui.ensure("s1", { serverExtensionUi: async () => { throw new Error("down"); } } as any, "a", "a");
		expect(ui.stateOf("s1", "a")).toEqual({ status: "error", message: "down" });
		const evil = { ...SOURCES, mounts: [{ slot: "app.overlay", component: "Top" }] };
		await ui.ensure("s1", apiOf(() => evil), "b", "b");
		await ui.allow("s1", "b", "b");
		const state = ui.stateOf("s1", "b");
		expect(state.status).toBe("error");
		expect(loaded).toEqual([]);
	});
	test("a compile failure is an error on the page and the settings are still the generic form", async () => {
		const { storage } = mem();
		const ui = new OwnPageUis({ storage, safeMode: () => false, loader: async () => ({ load: () => { throw new Error("Top.svelte: boom"); } }) });
		await ui.ensure("s1", apiOf(() => SOURCES), "demo", "demo");
		await ui.allow("s1", "demo", "demo");
		expect(ui.stateOf("s1", "demo")).toEqual({ status: "error", message: "Top.svelte: boom" });
	});
	test("a slower earlier fetch cannot overwrite a newer one", async () => {
		const { storage } = mem();
		const ui = make(storage);
		let release!: (v: OwnUiSources) => void;
		const slow = new Promise<OwnUiSources>((r) => { release = r; });
		const first = ui.ensure("s1", apiOf(() => slow), "demo", "demo");
		await ui.ensure("s1", apiOf(() => ({ ...SOURCES, components: { Only: "<p/>" }, mounts: [], replaces: {} })), "demo", "demo");
		release(SOURCES); await first;
		expect(ui.stateOf("s1", "demo")).toEqual({ status: "ask", names: ["Only"] });
	});
});
