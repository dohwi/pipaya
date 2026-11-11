import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { OWNED_PAGE_NAMES, parsePackage, UI_PARTS, UI_SLOTS, type SettingField } from "../src/lib/extensions/schema";
import { planPartialSave } from "../src/lib/extensions/settings-save";
import { formKeys, keepUnowned, writableKeys } from "../src/lib/extensions/settings-store";
import { serverPanelView } from "../src/lib/server-panel";
import type { ServerExtensionFeed as FeedType } from "../src/lib/server-extension-feed.svelte";
import { serverFields } from "../src/lib/server-extension";

// The real rune module, compiled with Svelte (it has no imports of its own).
let ServerExtensionFeed: typeof FeedType;
let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(process.cwd(), "tests", ".extension-feed-"));
	const source = ts.transpileModule(await Bun.file(resolve("src/lib/server-extension-feed.svelte.ts")).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	await writeFile(join(dir, "feed.mjs"), compileModule(source, { filename: "server-extension-feed.svelte.js", generate: "client" }).js.code);
	ServerExtensionFeed = (await import(join(dir, "feed.mjs"))).ServerExtensionFeed;
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const fields: SettingField[] = [
	{ key: "url", type: "string", label: "URL", required: true },
	{ key: "interval", type: "number", label: "Interval", min: 1, max: 60, default: 5 },
	{ key: "status", type: "string", label: "Status", readonly: true },
	{ key: "token", type: "string", label: "Token", secret: true },
];

describe("which keys a settings form owns", () => {
	test("every declared field except a read-only one", () => {
		expect(formKeys(fields)).toEqual(["url", "interval", "token"]);
		expect(formKeys([])).toBeUndefined();
		expect(formKeys(undefined)).toBeUndefined();
	});
	test("a client extension's write also leaves out what never leaves the device", () => {
		expect(writableKeys(fields)).toEqual(["url", "interval"]);
		expect(writableKeys([{ key: "path", type: "string", label: "P", device: true }, { key: "a", type: "string", label: "A" }])).toEqual(["a"]);
	});
	test("a form save keeps the keys it does not own and drops a stale read-only value from the draft", () => {
		const stored = { url: "old", status: "connected", mine: { n: 1 }, token: "t" };
		expect(keepUnowned(fields, stored, { url: "new", interval: 5 })).toEqual({ status: "connected", mine: { n: 1 }, url: "new", interval: 5 });
		// without a schema the raw object is the form
		expect(keepUnowned(undefined, stored, { a: 1 })).toEqual({ a: 1 });
	});
	test("a key the form owns and left empty is removed, not kept", () => {
		expect(keepUnowned(fields, { url: "u", interval: 9 }, { url: "u" })).toEqual({ url: "u" });
	});
});

describe("save(partial) of an extension's own settings section", () => {
	const current = { url: "u", interval: 5, status: "ok", extra: 1 };
	test("changes only the named keys, validated against the schema", () => {
		const plan = planPartialSave(fields, current, { interval: 10 });
		expect(plan.changed).toEqual({ interval: 10 });
		expect(plan.keys).toEqual(["interval"]);
		expect(plan.whole).toEqual({ url: "u", interval: 10, status: "ok", extra: 1 });
	});
	test("refuses a value the schema refuses, an undeclared key and a read-only one", () => {
		expect(() => planPartialSave(fields, current, { interval: 500 })).toThrow();
		expect(() => planPartialSave(fields, current, { interval: "5" })).toThrow();
		expect(() => planPartialSave(fields, current, { unknown: 1 })).toThrow();
		expect(() => planPartialSave(fields, current, { status: "forged" })).toThrow();
		expect(() => planPartialSave(fields, { ...current, url: "" }, { interval: 3 })).toThrow(); // the result must be valid as a whole
	});
	test("null or undefined clears a key, falling back to its default (none: the key is removed)", () => {
		const plan = planPartialSave(fields, current, { interval: null });
		expect(plan.keys).toEqual(["interval"]);
		expect(plan.whole.interval).toBe(5);
		expect(plan.changed).toEqual({ interval: 5 });
		const noDefault = planPartialSave([{ key: "a", type: "string", label: "A" }], { a: "x", other: 1 }, { a: undefined });
		expect(noDefault.whole).toEqual({ other: 1 });
		expect(noDefault.changed).toEqual({});
		expect(noDefault.keys).toEqual(["a"]);
	});
	test("an empty change is a no-op that is still valid", () => {
		const plan = planPartialSave(fields, current, {});
		expect(plan.keys).toEqual([]);
		expect(plan.whole).toEqual(current);
	});
	test("not an object, or object internals, are refused", () => {
		for (const bad of [null, undefined, "x", 3, [], [{ interval: 1 }]]) expect(() => planPartialSave(fields, current, bad)).toThrow();
		expect(() => planPartialSave(fields, current, JSON.parse('{"__proto__":{"a":1}}'))).toThrow();
		expect(() => planPartialSave(fields, current, { constructor: 1 })).toThrow();
		expect(() => planPartialSave(fields, current, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1])))).toThrow();
	});
	test("without a schema any key may be set, within the size cap", () => {
		expect(planPartialSave(undefined, { a: 1 }, { b: 2 })).toEqual({ whole: { a: 1, b: 2 }, changed: { b: 2 }, keys: ["b"] });
		expect(() => planPartialSave(undefined, {}, { big: "x".repeat(17000) })).toThrow();
	});
});

describe("the page a server extension shows", () => {
	test("text may be a string or { ko, en }, and a plain string follows pipaya.translations", () => {
		const tree = {
			type: "card", id: "c", title: { ko: "상태", en: "Status" }, children: [
				{ type: "text", id: "t1", text: { ko: "연결됨", en: "Connected" } },
				{ type: "text", id: "t2", text: "원래 문장" },
				{ type: "stat", id: "s", label: "Items", value: { ko: "2개", en: "2" } },
				{ type: "button", id: "b", label: { ko: "지금 동기화", en: "Sync now" } },
			],
		};
		const en = serverPanelView(tree, { en: { "원래 문장": "Original" } }, "en").view as any;
		expect(en.title).toBe("Status");
		expect(en.children.map((c: any) => c.text ?? c.value ?? c.label)).toEqual(["Connected", "Original", "2", "Sync now"]);
		const ko = serverPanelView(tree, { en: { "원래 문장": "Original" } }, "ko").view as any;
		expect(ko.title).toBe("상태");
		expect(ko.children.map((c: any) => c.text ?? c.value ?? c.label)).toEqual(["연결됨", "원래 문장", "2개", "지금 동기화"]);
	});
	test("table cells, list items and tab labels are localized; ids, types and field values are not touched", () => {
		const tree = {
			type: "tabs", id: "tabs", items: [
				{ id: "one", label: { ko: "하나", en: "One" }, children: [
					{ type: "table", id: "tb", columns: [{ id: "a", label: { ko: "열", en: "Col" } }], rows: [{ id: "r", cells: [{ ko: "칸", en: "Cell" }] }] },
					{ type: "list", id: "ls", items: [{ id: "i", title: { ko: "항목", en: "Item" }, badge: { ko: "새", en: "New" } }], emptyText: { ko: "없음", en: "None" } },
					{ type: "select", id: "sel", label: "Pick", value: "b", options: [{ value: "a", label: { ko: "가", en: "A" } }, { value: "b", label: "B" }] },
				] },
			],
		};
		const v = serverPanelView(tree, undefined, "en").view as any;
		const kids = v.items[0].children;
		expect(v.items[0].label).toBe("One");
		expect(kids[0].columns[0].label).toBe("Col");
		expect(kids[0].rows[0].cells).toEqual(["Cell"]);
		expect(kids[1].items[0]).toMatchObject({ id: "i", title: "Item", badge: "New" });
		expect(kids[1].emptyText).toBe("None");
		expect(kids[2]).toMatchObject({ id: "sel", value: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
	});
	test("no page, a page of a newer kind, or a broken one shows nothing and says why", () => {
		expect(serverPanelView(undefined)).toEqual({ view: null });
		expect(serverPanelView(null)).toEqual({ view: null });
		expect(serverPanelView({ type: "hologram", id: "x" }).view).toBeNull();
		expect(serverPanelView({ type: "hologram", id: "x" }).problem).toContain("type");
		expect(serverPanelView({ type: "text", id: "x", text: "a", onclick: "x()" }).problem).toContain("unknown field");
		expect(serverPanelView({ type: "text", id: "Bad Id", text: "a" }).view).toBeNull();
		expect(serverPanelView("text").view).toBeNull();
	});
	test("the client's own limits apply: depth, nodes and the size of text", () => {
		const nest = (n: number): any => (n <= 1 ? { type: "text", id: "leaf", text: "x" } : { type: "stack", id: `s${n}`, children: [nest(n - 1)] });
		expect(serverPanelView(nest(8)).view).not.toBeNull();
		expect(serverPanelView(nest(9)).view).toBeNull();
		expect(serverPanelView({ type: "text", id: "t", text: "x".repeat(8001) }).view).toBeNull();
		expect(serverPanelView({ type: "text", id: "t", text: "" }).view).toBeNull();
	});
	test("a value that looks like a language table but is not stays as it is", () => {
		// not language tags, or a non-string entry: left alone, then refused by the node parser as a bad text
		expect(serverPanelView({ type: "text", id: "t", text: { "not a tag": "x" } }, undefined, "en").view).toBeNull();
		expect(serverPanelView({ type: "text", id: "t", text: { en: 1 } }, undefined, "en").view).toBeNull();
		expect(serverPanelView({ type: "text", id: "t", text: {} }, undefined, "en").view).toBeNull();
	});
	test("a language the value lacks falls back the way settings values do", () => {
		const v = serverPanelView({ type: "text", id: "t", text: { ko: "한국어" } }, undefined, "en").view as any;
		expect(v.text).toBe("한국어");
	});
});

describe("live feed of a server's extension events", () => {
	test("settings changes and reloads are counted per server, so a page reads again", () => {
		const feed = new ServerExtensionFeed();
		expect(feed.settingsTick("a")).toBe(0);
		feed.onEvent("a", "extension_settings_updated", { id: "x", action: "saved" });
		feed.onEvent("a", "extension_settings_updated", { id: "y", action: "deleted" });
		feed.onEvent("b", "extension_settings_updated", { id: "x" });
		expect([feed.settingsTick("a"), feed.settingsTick("b"), feed.settingsTick("c")]).toEqual([2, 1, 0]);
		feed.onEvent("a", "extensions_updated", { names: [] });
		expect([feed.reloadTick("a"), feed.reloadTick("b")]).toEqual([1, 0]);
	});
	test("a pushed page is kept per server and extension, null means removed, and a reload forgets it", () => {
		const feed = new ServerExtensionFeed();
		expect(feed.panelFor("a", "x")).toBeUndefined();
		feed.onEvent("a", "extension_panel_updated", { extension: "x", panel: { type: "text", id: "t", text: "1" } });
		feed.onEvent("a", "extension_panel_updated", { extension: "y", panel: null });
		expect(feed.panelFor("a", "x")).toEqual({ panel: { type: "text", id: "t", text: "1" } });
		expect(feed.panelFor("a", "y")).toEqual({ panel: null });
		expect(feed.panelFor("b", "x")).toBeUndefined();
		feed.onEvent("a", "extensions_updated", {});
		expect(feed.panelFor("a", "x")).toBeUndefined();
	});
	test("malformed or unrelated events change nothing and never throw", () => {
		const feed = new ServerExtensionFeed();
		for (const data of [null, undefined, "x", 1, [], {}]) {
			feed.onEvent("a", "extension_panel_updated", data);
			feed.onEvent("a", "extension_settings_updated", data);
		}
		feed.onEvent("a", "session_updated", { id: "x" });
		expect(feed.panelFor("a", "x")).toBeUndefined();
		expect(feed.reloadTick("a")).toBe(0);
	});
});

describe("manifest: the component of a settings field and the page names", () => {
	const base = (field: object, extra: Record<string, unknown> = {}) => ({
		manifest: { id: "example.page", name: "Page", version: "1.0.0", sdkVersion: 1, permissions: ["ui-components"], settings: [{ key: "level", type: "number", label: "Level", ...field }] },
		components: { Slider: "<p/>" },
		...extra,
	});
	test("a field may name a component of the package", () => {
		expect(parsePackage(base({ component: "Slider" })).manifest.settings?.[0]?.component).toBe("Slider");
		expect(parsePackage(base({})).manifest.settings?.[0]?.component).toBeUndefined();
	});
	test("an unknown or malformed component name, or a package without components, is refused", () => {
		expect(() => parsePackage(base({ component: "Missing" }))).toThrow(/unknown component/);
		expect(() => parsePackage(base({ component: "slider" }))).toThrow(/PascalCase/);
		expect(() => parsePackage(base({ component: 5 }))).toThrow();
		// a package that has settings but no components at all
		const { components: _none, ...withoutComponents } = base({ component: "Slider" }) as Record<string, any>;
		expect(() => parsePackage({ ...withoutComponents, commands: [{ name: "c", description: "d", template: "t" }], manifest: { ...withoutComponents.manifest, permissions: ["commands", "composer"] } })).toThrow(/unknown component/);
	});
	test("the page part and slot are named once, and are the ones only an owner may fill", () => {
		expect(UI_PARTS).toContain("extension.settings");
		expect(UI_SLOTS).toContain("extension.page.top");
		expect([...OWNED_PAGE_NAMES].sort()).toEqual(["extension.page.top", "extension.settings"]);
		const mounted = parsePackage(base({}, { mounts: [{ slot: "extension.page.top", component: "Slider" }], replaces: { "extension.settings": "Slider" } }));
		expect(mounted.mounts?.[0]?.slot).toBe("extension.page.top");
		expect(mounted.replaces?.["extension.settings"]).toBe("Slider");
	});
	test("a server extension's field may carry `component`, and an older app drops a key it does not know", () => {
		const form = serverFields({ settings: [{ key: "a", type: "string", label: "A", component: "Thing", futureKey: 1 }] });
		expect(form.problem).toBeUndefined();
		expect(form.fields?.[0]).toMatchObject({ key: "a", component: "Thing" });
	});
});
