import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type * as FeedbackModule from "../src/lib/feedback.svelte";
import type * as SidebarModule from "../src/lib/sidebar.svelte";
import type * as ServerPrefsModule from "../src/lib/server-prefs.svelte";

// Compile the real rune module with Svelte, rather than substituting fake $state globals (as tests/compaction.test.ts does).
let Feedback: typeof FeedbackModule.Feedback;
let NOTICE_MAX: number;
let reorder: typeof SidebarModule.reorder;
let SidebarState: typeof SidebarModule.SidebarState;
let ServerPrefs: typeof ServerPrefsModule.ServerPrefs;
let dir: string;

async function loadRunes(name: string) {
	const build = await Bun.build({
		entrypoints: [resolve(`src/lib/${name}.svelte.ts`)], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
				return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, `${name}.mjs`);
	await writeFile(file, await build.outputs[0]!.text());
	return import(file);
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-store-parts-"));
	({ Feedback, NOTICE_MAX } = await loadRunes("feedback"));
	// sidebar.svelte.ts reads localStorage at construction only; reorder is a pure function
	(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {} };
	({ reorder, SidebarState } = await loadRunes("sidebar"));
	({ ServerPrefs } = await loadRunes("server-prefs"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("sidebar reorder", () => {
	test("moves an entry before or after another", () => {
		expect(reorder(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
		expect(reorder(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
	});
	test("no change when dropped on itself or on something not listed", () => {
		expect(reorder(["a", "b"], "a", "a", true)).toBeNull();
		expect(reorder(["a", "b"], "a", "z", true)).toBeNull();
	});
});

describe("sidebar moveDir", () => {
	test("keeps the rank of folders that are not listed while dragging", () => {
		const sb = new SidebarState();
		sb.dirOrder = { s1: ["/a", "/hidden", "/b", "/c"] };
		sb.moveDir("s1", ["/a", "/b", "/c"], "/c", "/a", false);
		expect(sb.dirOrder.s1).toEqual(["/c", "/a", "/b", "/hidden"]);
	});
});

describe("feedback", () => {
	test("a session's toast shows in its pane while on screen, globally otherwise", () => {
		const f = new Feedback();
		f.toast("global");
		f.toast("about s1", "error", "s1");
		expect(f.global(["s1"]).map((x) => x.text)).toEqual(["global"]);
		expect(f.of("s1", ["s1"]).map((x) => x.text)).toEqual(["about s1"]);
		expect(f.global([]).map((x) => x.text)).toEqual(["global", "about s1"]);
		for (const x of [...f.toasts]) f.dismissToast(x.id);
		expect(f.toasts).toEqual([]);
	});
	test("one notice per session, newest first, at most NOTICE_MAX", () => {
		const f = new Feedback();
		f.announce("a", "done");
		f.announce("a", "failed");
		expect(f.notices.map((n) => [n.sid, n.tone])).toEqual([["a", "failed"]]);
		for (let i = 0; i < NOTICE_MAX + 2; i++) f.announce(`s${i}`, "done");
		expect(f.notices.length).toBe(NOTICE_MAX);
		expect(f.notices[0]!.sid).toBe(`s${NOTICE_MAX + 1}`);
		for (const n of [...f.notices]) f.dismissNotice(n.id);
	});
});

describe("server preferences", () => {
	const store = new Map<string, string>();
	const model = (provider: string, id: string) => ({ provider, id }) as never;
	const make = (models: never[] = []) => {
		const changed: string[] = [];
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
		return { changed, prefs: new ServerPrefs((k) => changed.push(k), () => models) };
	};

	test("stars are kept per server and reported as changes", () => {
		store.clear();
		const a = make();
		a.prefs.load("s1");
		a.prefs.toggleFavModel("openai", "gpt");
		a.prefs.toggleFavDir("/work");
		expect(a.changed).toEqual(["favModels", "favDirs"]);
		expect(a.prefs.isFavModel("openai", "gpt")).toBe(true);
		const b = make();
		b.prefs.load("s1");
		expect(b.prefs.favModels).toEqual(["openai\u0000gpt"]);
		expect(b.prefs.favDirs).toEqual(["/work"]);
		b.prefs.load("s2");
		expect(b.prefs.favModels).toEqual([]); // another server has its own stars
		b.prefs.toggleFavModel("openai", "gpt");
		expect(b.prefs.isFavModel("openai", "gpt")).toBe(true);
		b.prefs.toggleFavModel("openai", "gpt");
		expect(b.prefs.isFavModel("openai", "gpt")).toBe(false);
	});

	test("only models that still exist are listed, in the order they were starred", () => {
		store.clear();
		const { prefs } = make([model("a", "1"), model("b", "2")]);
		prefs.load("s");
		prefs.toggleFavModel("b", "2");
		prefs.toggleFavModel("gone", "x");
		prefs.toggleFavModel("a", "1");
		expect(prefs.favModelList.map((m) => `${m.provider}/${m.id}`)).toEqual(["b/2", "a/1"]);
	});

	test("the notification delay accepts only the offered choices", () => {
		store.clear();
		const { prefs, changed } = make();
		prefs.load("s");
		expect(prefs.escalateMinutes).toBe(3);
		prefs.setEscalateMinutes(7); // not a choice
		prefs.setEscalateMinutes(3); // unchanged
		expect(changed).toEqual([]);
		prefs.setEscalateMinutes(10);
		expect(prefs.escalateMinutes).toBe(10);
		expect(changed).toEqual(["notificationPolicy"]);
		expect(store.get("pipaya.notify.escalate.s")).toBe("10");
	});

	test("damaged stored values fall back instead of breaking the load", () => {
		store.clear();
		store.set("pipaya.fav.models.s", JSON.stringify([1, "ok", null]));
		store.set("pipaya.fav.dirs.s", "{not json");
		store.set("pipaya.notify.escalate.s", JSON.stringify(99));
		const { prefs } = make();
		prefs.load("s");
		expect(prefs.favModels).toEqual(["ok"]);
		expect(prefs.favDirs).toEqual([]);
		expect(prefs.escalateMinutes).toBe(3);
	});

	test("the sync adapters offer only what this device chose, and apply what the server sends", () => {
		store.clear();
		const { prefs } = make();
		prefs.load("s");
		const ad = prefs.adapters("s");
		expect(ad.favModels!.read()).toBeUndefined();
		expect(ad.notificationPolicy!.read()).toBeUndefined();
		ad.favModels!.apply(["x", 5]);
		ad.notificationPolicy!.apply({ escalateMinutes: 15 });
		ad.notificationPolicy!.apply({ escalateMinutes: 8 }); // not a choice: ignored
		expect(prefs.favModels).toEqual(["x"]);
		expect(prefs.escalateMinutes).toBe(15);
		expect(ad.favModels!.read()).toEqual(["x"]);
		expect(ad.notificationPolicy!.read()).toEqual({ escalateMinutes: 15 });
	});

	test("clear forgets the open server", () => {
		store.clear();
		const { prefs } = make();
		prefs.load("s");
		prefs.toggleFavDir("/a");
		prefs.clear();
		expect(prefs.favDirs).toEqual([]);
		prefs.toggleFavDir("/b"); // no server in view: kept in memory only
		expect(store.get("pipaya.fav.dirs.s")).toBe(JSON.stringify(["/a"]));
	});
});
