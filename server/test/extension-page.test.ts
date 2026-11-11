import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { ExtensionSettings } from "../src/extension-settings.ts";
import { checkPanel, PANEL_LIMITS } from "../src/extensions/host.ts";

// A page an extension shows above its settings form (`pi.ui`), and form saves that keep the keys a form does not edit.

const PAGE = `
export default (pi) => {
	let seen = [];
	pi.ui.onEvent((e) => {
		if (e.id === "boom") throw new Error("handler failed");
		seen.push(e);
	});
	pi.registerMethod("panel", (p) => { pi.ui.setPanel(p); return true; });
	pi.registerMethod("panelBad", (p) => { try { pi.ui.setPanel(p); return "no error"; } catch (e) { return e.message; } });
	pi.registerMethod("seen", () => seen);
	pi.registerMethod("own", (p) => pi.settings.set(p));
};
`;
const PLAIN = "export default () => {};";

let app: App;
let dir: string;
const call = async (method: any, url: string, payload?: unknown) => {
	const r = await app.server.inject({ method, url, headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
	return { status: r.statusCode, json: r.body ? r.json() : undefined };
};
const method = async (name: string, params: unknown = {}) => (await call("POST", `/server-extensions/page/methods/${name}`, params)).json?.result;
const listed = async (name: string) => (await call("GET", "/server-extensions")).json.extensions.find((e: any) => e.name === name);
const button = (extra: object = {}) => ({ type: "stack", id: "root", children: [{ type: "button", id: "go", label: "Go" }, { type: "form", id: "f", submitLabel: "Save", children: [{ type: "input", id: "name", label: "Name" }] }, ...[extra].filter((x) => Object.keys(x).length)] });

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pipaya-ext-page-"));
	const exts = join(dir, "exts");
	mkdirSync(exts, { recursive: true });
	writeFileSync(join(exts, "page.js"), PAGE);
	writeFileSync(join(exts, "plain.js"), PLAIN);
	const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), logLevel: "silent" };
	app = await buildApp(cfg, { strictResponses: true, extensionDirs: [exts], home: dir });
});
afterAll(async () => {
	await app.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("pi.ui.setPanel", () => {
	test("an extension without a page is listed exactly as before", async () => {
		expect(await listed("plain")).not.toHaveProperty("panel");
		expect(await listed("page")).not.toHaveProperty("panel");
	});

	test("the page is served with the list, replaced, and removed with null", async () => {
		const tree = { type: "card", id: "status", title: { ko: "상태", en: "Status" }, children: [{ type: "text", id: "line", text: { ko: "연결됨", en: "Connected" } }] };
		expect(await method("panel", tree)).toBe(true);
		expect((await listed("page")).panel).toEqual(tree);
		expect(await listed("plain")).not.toHaveProperty("panel");
		await method("panel", null);
		expect(await listed("page")).not.toHaveProperty("panel");
	});

	test("a change is pushed once as a live-only event, and an identical tree is not pushed again", async () => {
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.type === "extension_panel_updated") seen.push(e); });
		const tree = { type: "text", id: "t", text: "a" };
		await method("panel", tree);
		await method("panel", { ...tree });
		await method("panel", { type: "text", id: "t", text: "b" });
		await method("panel", null);
		await method("panel", null);
		off();
		expect(seen.map((e) => e.data)).toEqual([
			{ extension: "page", panel: tree },
			{ extension: "page", panel: { type: "text", id: "t", text: "b" } },
			{ extension: "page", panel: null },
		]);
		expect(seen.every((e) => e.sessionId === null)).toBe(true);
	});

	test("a reload drops the page until the extension sets it again", async () => {
		await method("panel", { type: "text", id: "t", text: "a" });
		expect((await call("POST", "/server-extensions/reload")).status).toBe(200);
		expect(await listed("page")).not.toHaveProperty("panel");
	});

	test("an invalid tree throws in the extension and leaves the old page", async () => {
		const ok = { type: "text", id: "t", text: "a" };
		await method("panel", ok);
		const refused = async (tree: unknown) => String(await method("panelBad", tree));
		expect(await refused({ type: "text" })).toContain("id");
		expect(await refused({ type: "text", id: "Bad Id" })).toContain("id");
		expect(await refused({ id: "x" })).toContain("type");
		expect(await refused([])).toContain("node object");
		expect(await refused("text")).toContain("node object");
		expect(await refused({ type: "stack", id: "a", children: [{ type: "text", id: "a" }] })).toContain("duplicate");
		expect(await refused({ type: "stack", id: "a", children: "no" })).toContain("children");
		expect(await refused({ type: "tabs", id: "a", items: [{ id: "a", children: [] }] })).toContain("duplicate");
		expect((await listed("page")).panel).toEqual(ok);
		await method("panel", null);
	});
});

describe("checkPanel limits", () => {
	const nest = (levels: number): any => (levels <= 1 ? { type: "text", id: "n1" } : { type: "stack", id: `n${levels}`, children: [nest(levels - 1)] });
	test("depth, node count, children and bytes are capped like the client's view limits", () => {
		expect(() => checkPanel(nest(PANEL_LIMITS.depth))).not.toThrow();
		expect(() => checkPanel(nest(PANEL_LIMITS.depth + 1))).toThrow("levels");
		const flat = (n: number) => ({ type: "stack", id: "root", children: Array.from({ length: n }, (_, i) => ({ type: "text", id: `t${i}` })) });
		expect(() => checkPanel(flat(PANEL_LIMITS.children))).not.toThrow();
		expect(() => checkPanel(flat(PANEL_LIMITS.children + 1))).toThrow("at most");
		const wide = { type: "stack", id: "root", children: Array.from({ length: 5 }, (_, g) => ({ type: "stack", id: `g${g}`, children: Array.from({ length: 50 }, (_, i) => ({ type: "text", id: `g${g}-${i}` })) })) };
		expect(() => checkPanel(wide)).toThrow("nodes");
		expect(() => checkPanel({ type: "text", id: "t", text: "x".repeat(PANEL_LIMITS.bytes) })).toThrow("bytes");
	});
	test("returns a copy, and refuses what is not plain JSON", () => {
		const input = { type: "text", id: "t", text: "a" };
		const out = checkPanel(input);
		expect(out).toEqual(input);
		expect(out).not.toBe(input);
		const cyclic: any = { type: "stack", id: "c", children: [] };
		cyclic.children.push(cyclic);
		expect(() => checkPanel(cyclic)).toThrow("plain JSON");
		expect(() => checkPanel({ type: "text", id: "t", n: 1n })).toThrow("plain JSON");
		expect(() => checkPanel(undefined)).toThrow("plain JSON");
	});
});

describe("POST /server-extensions/:extension/panel/event", () => {
	const send = (event: unknown, ext = "page") => call("POST", `/server-extensions/${ext}/panel/event`, { event });
	test("buttons and forms reach the extension's handler with a validated copy", async () => {
		await method("panel", button());
		expect((await send({ type: "action", id: "go" })).status).toBe(200);
		expect((await send({ type: "submit", id: "f", values: { name: "x", on: true } })).json).toEqual({ ok: true });
		expect((await send({ type: "change", id: "name", value: "y" })).status).toBe(200);
		expect(await method("seen")).toEqual([
			{ type: "action", id: "go" },
			{ type: "submit", id: "f", values: { name: "x", on: true } },
			{ type: "change", id: "name", value: "y" },
		]);
	});

	test("an event for a node that is not there, of the wrong kind, or malformed is refused before the handler", async () => {
		const before = ((await method("seen")) as unknown[]).length;
		for (const event of [
			{ type: "action", id: "missing" }, { type: "action", id: "f" }, { type: "submit", id: "go", values: {} }, { type: "change", id: "go", value: "x" },
			{ type: "change", id: "name", value: 3 }, { type: "submit", id: "f", values: { a: { b: 1 } } }, { type: "submit", id: "f", values: [] }, { type: "other", id: "go" }, { type: "action" }, null, "go",
		]) {
			const r = await send(event);
			expect([400]).toContain(r.status);
		}
		expect(((await method("seen")) as unknown[]).length).toBe(before);
	});

	test("a disabled target is refused, and so is a page that is gone", async () => {
		await method("panel", { type: "button", id: "off", label: "Off", disabled: true });
		expect((await send({ type: "action", id: "off" })).status).toBe(400);
		await method("panel", null);
		expect((await send({ type: "action", id: "go" })).status).toBe(404);
	});

	test("an unknown extension is 404, a handler that throws is a 400 with its message and is logged", async () => {
		expect((await send({ type: "action", id: "go" }, "nope")).status).toBe(404);
		expect((await send({ type: "action", id: "go" }, "plain")).status).toBe(404);
		await method("panel", { type: "button", id: "boom", label: "Boom" });
		const r = await send({ type: "action", id: "boom" });
		expect(r.status).toBe(400);
		expect(r.json.error.message).toContain("handler failed");
		expect((await call("GET", "/server-extensions/errors?extension=page")).json.errors.some((e: any) => e.where === "panel:event")).toBe(true);
		await method("panel", null);
	});

	test("the event is in the catalogue as a live-only event", async () => {
		const list = (await call("GET", "/events/types")).json.events;
		expect(list.find((e: any) => e.type === "extension_panel_updated")?.persisted).toBe(false);
	});
});

describe("settings writes that keep the keys a form does not edit", () => {
	const put = (id: string, body: object) => call("PUT", `/extensions/${id}/settings`, body);
	const stored = async (id: string) => (await call("GET", `/extensions/${id}/settings`)).json;

	test("`keys` replaces only those keys: undeclared keys and the extension's own values stay", async () => {
		await put("keep.one", { settings: { url: "a", mode: "x", status: "ok", mine: { n: 1 } } });
		const r = await put("keep.one", { settings: { url: "b" }, keys: ["url", "mode"] });
		expect(r.json.applied).toBe(true);
		expect(r.json.value).toEqual({ url: "b", status: "ok", mine: { n: 1 } }); // a listed key missing from the body is removed
		expect((await stored("keep.one")).value).toEqual(r.json.value);
	});

	test("without `keys` the whole object is replaced as before", async () => {
		await put("keep.two", { settings: { a: 1, b: 2 } });
		expect((await put("keep.two", { settings: { a: 3 } })).json.value).toEqual({ a: 3 });
	});

	test("an empty `keys` list changes nothing, and a keyed write creates the object when there is none", async () => {
		await put("keep.three", { settings: { a: 1 } });
		expect((await put("keep.three", { settings: { a: 2 }, keys: [] })).json.value).toEqual({ a: 1 });
		expect((await put("keep.fresh", { settings: { a: 1, ignored: 2 }, keys: ["a"] })).json.value).toEqual({ a: 1 });
	});

	test("keys that could reach object internals or are not names are refused", async () => {
		for (const keys of [["__proto__"], ["constructor"], ["prototype"], [""], ["x".repeat(81)], Array.from({ length: 101 }, (_, i) => `k${i}`)]) {
			expect((await put("keep.bad", { settings: { a: 1 }, keys })).status).toBe(400);
		}
		expect((await call("GET", "/extensions/keep.bad/settings")).status).toBe(404);
		// a body that names __proto__ is refused by the JSON parser before it reaches the store
		const raw = await app.server.inject({ method: "PUT", url: "/extensions/keep.proto/settings", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, payload: '{"settings":{"a":1,"__proto__":{"x":1}},"keys":["a"]}' });
		expect(raw.statusCode).toBe(400);
		expect(({} as any).x).toBeUndefined();
	});

	test("the size cap applies to the merged object", async () => {
		await put("keep.big", { settings: { big: "x".repeat(15000) } });
		expect((await put("keep.big", { settings: { more: "y".repeat(2000) }, keys: ["more"] })).status).toBe(413);
		expect((await stored("keep.big")).value).toEqual({ big: "x".repeat(15000) });
	});

	test("the event is published for an applied keyed write, and not for a stale one", async () => {
		const t0 = Date.now() - 60_000;
		await put("keep.evt", { settings: { a: 1 }, at: t0 + 1000 });
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.type === "extension_settings_updated") seen.push(e.data); });
		await put("keep.evt", { settings: { a: 0 }, keys: ["a"], at: t0 });
		await put("keep.evt", { settings: { a: 2 }, keys: ["a"], origin: "dev" });
		off();
		expect(seen).toEqual([{ id: "keep.evt", action: "saved", updatedAt: expect.any(Number), origin: "dev" }]);
	});

	test("the extension rewriting its own settings does not make a person's earlier edit stale", async () => {
		const store = new ExtensionSettings(dir);
		const t0 = Date.now() - 10_000;
		store.save("keep.lww", { url: "a" }, t0);
		// the extension writes its status "later" than the person's form was opened (a device clock a little behind)
		store.save("keep.lww", { url: "a", status: "ok" }, undefined, Date.now(), { by: "extension" });
		const r = store.save("keep.lww", { url: "b" }, t0 + 1000, Date.now(), { keys: ["url"] });
		expect(r.applied).toBe(true);
		expect(r.value).toEqual({ url: "b", status: "ok" });
		// a person's newer edit still wins over an older person's keyed write
		const stale = store.save("keep.lww", { url: "old" }, t0 + 500, Date.now(), { keys: ["url"] });
		expect(stale.applied).toBe(false);
		expect(stale.value.url).toBe("b");
		// a whole-object write (no keys) still competes with the value's own time, as before
		expect(store.save("keep.lww", { x: 1 }, t0 + 100).applied).toBe(false);
	});

	test("an extension's own write (pi.settings.set) is reported through the same event, and keeps working", async () => {
		const seen: any[] = [];
		const off = app.bus.subscribe((e) => { if (e.type === "extension_settings_updated") seen.push(e.data); });
		expect(await method("own", { status: "ok" })).toEqual({ status: "ok" });
		off();
		expect(seen).toEqual([{ id: "page", action: "saved", updatedAt: expect.any(Number) }]);
		expect((await stored("page")).value).toEqual({ status: "ok" });
	});

	test("a stamp file written before the user stamp existed is read as before", async () => {
		const store = new ExtensionSettings(dir);
		const folder = join(dir, "extensions", "keep.old");
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "settings.json"), '{"a":1}');
		writeFileSync(join(folder, "settings.at"), "1700000000000");
		expect(store.getStored("keep.old")).toEqual({ value: { a: 1 }, updatedAt: 1700000000000 });
		const r = store.save("keep.old", { a: 2 }, 1700000000001, Date.now(), { keys: ["a"] });
		expect(r.applied).toBe(true);
		expect(readFileSync(join(folder, "settings.at"), "utf8")).toBe("1700000000001 1700000000001");
		expect(store.getStored("keep.old")?.updatedAt).toBe(1700000000001);
	});
});

describe("components a server extension carries for its own page (pipaya.components)", () => {
	let own: App;
	let ownDir: string;
	const get = async (url: string) => {
		const r = await own.server.inject({ method: "GET", url, headers: { authorization: "Bearer test-token" } });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};
	beforeAll(async () => {
		ownDir = mkdtempSync(join(tmpdir(), "pipaya-ext-own-"));
		const exts = join(ownDir, "exts");
		const folder = join(exts, "ownui");
		mkdirSync(join(folder, "ui"), { recursive: true });
		writeFileSync(join(folder, "index.js"), "export default () => {};");
		writeFileSync(join(folder, "ui", "Top.svelte"), "<p>top</p>");
		writeFileSync(join(folder, "ui", "Section.svelte"), "<p>section</p>");
		writeFileSync(join(folder, "ui", "Big.svelte"), `<p>${"x".repeat(70 * 1024)}</p>`);
		writeFileSync(join(folder, "package.json"), JSON.stringify({ pipaya: {
			settings: [{ key: "level", type: "number", label: "Level", component: "Top" }],
			components: { Top: "ui/Top.svelte", Section: "ui/Section.svelte", Big: "ui/Big.svelte", Escape: "../../secret.svelte", "bad name": "ui/Top.svelte", Missing: "ui/Nope.svelte", NotSvelte: "ui/Top.js", Abs: "/etc/passwd.svelte" },
			mounts: [{ slot: "extension.page.top", component: "Top", order: 2 }, { slot: "app.overlay", component: "Top" }, { slot: "extension.page.top", component: "Ghost" }, { slot: "extension.page.top", component: "Section", order: 99999 }],
			replaces: { "extension.settings": "Section", "composer.send": "Top" },
		} }));
		const plain = join(exts, "plainui");
		mkdirSync(plain, { recursive: true });
		writeFileSync(join(plain, "index.js"), "export default () => {};");
		writeFileSync(join(plain, "package.json"), JSON.stringify({ pipaya: { components: { Top: "ui/Top.svelte" } } })); // names a file that is not there
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: ownDir, dbPath: join(ownDir, "db.sqlite"), token: "test-token", workspaceRoot: join(ownDir, "ws"), logLevel: "silent" };
		own = await buildApp(cfg, { strictResponses: true, extensionDirs: [exts], home: ownDir });
	});
	afterAll(async () => {
		await own.close();
		rmSync(ownDir, { recursive: true, force: true });
	});

	test("the list names the components and keeps only mounts and the part of the extension's own page", async () => {
		const e = (await get("/server-extensions")).json.extensions.find((x: any) => x.name === "ownui");
		expect([...e.ui.components].sort()).toEqual(["Section", "Top"]); // bad names, escapes, missing, oversized and non-.svelte files are dropped
		expect(e.ui.mounts).toEqual([{ slot: "extension.page.top", component: "Top", order: 2 }, { slot: "extension.page.top", component: "Section" }]);
		expect(e.ui.replaces).toEqual({ "extension.settings": "Section" });
	});

	test("an extension without pipaya.components is listed as before", async () => {
		const list = (await get("/server-extensions")).json.extensions;
		expect(list.find((x: any) => x.name === "plainui")).not.toHaveProperty("ui");
	});

	test("the sources are served by GET /server-extensions/:name/ui, only for what the extension declared", async () => {
		const r = await get("/server-extensions/ownui/ui");
		expect(r.status).toBe(200);
		expect(r.json.components).toEqual({ Top: "<p>top</p>", Section: "<p>section</p>" });
		expect(r.json.mounts).toEqual([{ slot: "extension.page.top", component: "Top", order: 2 }, { slot: "extension.page.top", component: "Section" }]);
		expect(r.json.replaces).toEqual({ "extension.settings": "Section" });
	});

	test("a missing or oversized file is left out of the list; an unknown extension or one without components is 404", async () => {
		expect((await get("/server-extensions/ownui")).status).toBe(404); // not a route
		expect((await get("/server-extensions/nope/ui")).status).toBe(404);
		expect((await get("/server-extensions/plainui/ui")).status).toBe(404);
		expect((await get("/server-extensions/plain/ui")).status).toBe(404);
	});

	test("an edit of a component file is served on the next request", async () => {
		writeFileSync(join(ownDir, "exts", "ownui", "ui", "Top.svelte"), "<p>changed</p>");
		expect((await get("/server-extensions/ownui/ui")).json.components.Top).toBe("<p>changed</p>");
		writeFileSync(join(ownDir, "exts", "ownui", "ui", "Top.svelte"), "x".repeat(70 * 1024));
		expect((await get("/server-extensions/ownui/ui")).status).toBe(400); // grew past the limit after loading
	});
});
