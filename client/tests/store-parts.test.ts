import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type * as FeedbackModule from "../src/lib/feedback.svelte";
import type * as SidebarModule from "../src/lib/sidebar.svelte";
import type * as ServerPrefsModule from "../src/lib/server-prefs.svelte";
import type * as ExtensionRequestsModule from "../src/lib/extension-requests.svelte";
import type * as PairingFlowModule from "../src/lib/pairing-flow.svelte";
import type * as CloseGuardModule from "../src/lib/close-guard.svelte";
import type * as IdleModule from "../src/lib/idle-extension-stores.svelte";
import { mergeServers, replaceServers } from "../src/lib/configuration-servers";

// Compile the real rune module with Svelte, rather than substituting fake $state globals (as tests/compaction.test.ts does).
let Feedback: typeof FeedbackModule.Feedback;
let NOTICE_MAX: number;
let reorder: typeof SidebarModule.reorder;
let SidebarState: typeof SidebarModule.SidebarState;
let ServerPrefs: typeof ServerPrefsModule.ServerPrefs;
let ExtensionRequests: typeof ExtensionRequestsModule.ExtensionRequests;
let IdleExtensionStores: typeof IdleModule.IdleExtensionStores;
let PairingFlow: typeof PairingFlowModule.PairingFlow;
let CloseGuard: typeof CloseGuardModule.CloseGuard;
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
	({ ExtensionRequests } = await loadRunes("extension-requests"));
	// the extension host and notifications modules it imports read session storage when they load
	(globalThis as any).sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
	({ IdleExtensionStores } = await loadRunes("idle-extension-stores"));
	({ PairingFlow } = await loadRunes("pairing-flow"));
	({ CloseGuard } = await loadRunes("close-guard"));
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

describe("sidebar reveal", () => {
	test("unfolds the one node that holds the row and leaves the rest folded", () => {
		const sb = new SidebarState();
		sb.folded = ["s1", "s1\u0000/a", "s1\u0000/b", "s2"];
		sb.reveal("s1\u0000/a");
		expect(sb.folded).toEqual(["s1", "s1\u0000/b", "s2"]);
	});
	test("a node that is already open is not touched", () => {
		const sb = new SidebarState();
		sb.folded = ["s1"];
		const before = sb.folded;
		sb.reveal("s1\u0000/a");
		expect(sb.folded).toBe(before);
	});
});

describe("sidebar shared part", () => {
	test("edits are reported; the server's value replaces one server's pins only", () => {
		(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
		const sb = new SidebarState();
		const edits: string[] = [];
		sb.onEdit = (id) => edits.push(id);
		expect(sb.shared("s1")).toBeUndefined();
		sb.togglePinned("s1", "/a");
		sb.toggleTabPinned("s1", "g1");
		sb.setDirName("s1", "/a", "A");
		expect(edits).toEqual(["s1", "s1", "s1"]);
		expect(JSON.parse(JSON.stringify(sb.shared("s1")))).toEqual({ pinnedDirs: ["/a"], pinnedTabs: ["g1"], dirOrder: [], tabOrder: [], dirNames: { "/a": "A" }, groupDir: {} });
		sb.togglePinned("s2", "/z");
		sb.applyShared("s1", { pinnedDirs: ["/b"], pinnedTabs: [1, "g2"], dirNames: "bad" });
		expect(JSON.parse(JSON.stringify(sb.pinned))).toEqual({ s1: ["/b"], s2: ["/z"] });
		expect([...sb.pinnedTabs.s1!]).toEqual(["g2"]);
		expect({ ...sb.dirNames.s1 }).toEqual({});
		const n = edits.length;
		sb.applyShared("s1", {});
		expect(edits.length).toBe(n); // a value from the server is not an edit
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

	test("quiet peers defaults on, persists per server and syncs inside notificationPolicy", () => {
		store.clear();
		const { prefs, changed } = make();
		prefs.load("s");
		expect(prefs.quietPeers).toBe(true);
		prefs.setQuietPeers(true); // unchanged
		expect(changed).toEqual([]);
		prefs.setQuietPeers(false);
		expect(changed).toEqual(["notificationPolicy"]);
		expect(store.get("pipaya.notify.quietPeers.s")).toBe("false");
		const ad = prefs.adapters("s");
		expect(ad.notificationPolicy!.read()).toEqual({ quietPeers: false });
		ad.notificationPolicy!.apply({ escalateMinutes: 5, quietPeers: true });
		expect(prefs.quietPeers).toBe(true);
		expect(ad.notificationPolicy!.read()).toEqual({ escalateMinutes: 5, quietPeers: true });
		prefs.load("s");
		expect(prefs.quietPeers).toBe(true);
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

describe("extension requests", () => {
	const req = (title: string) => ({ owner: "x", ownerName: "X", kind: "confirm" as const, title });
	test("questions wait their turn: the second shows once the first is answered", async () => {
		const r = new ExtensionRequests();
		const first = r.ask(req("one"));
		const second = r.ask(req("two"));
		await Promise.resolve();
		expect(r.dialog?.request.title).toBe("one");
		r.answer(true);
		expect(await first).toBe(true);
		await new Promise((f) => setTimeout(f, 0));
		expect(r.dialog?.request.title).toBe("two");
		r.answer(false);
		expect(await second).toBe(false);
		expect(r.dialog).toBeNull();
	});
	test("a second approval while one is open is refused, not queued", async () => {
		const r = new ExtensionRequests();
		const first = r.confirm("a");
		expect(await r.confirm("b")).toBe(false);
		expect(r.approval?.message).toBe("a");
		r.approve(true);
		expect(await first).toBe(true);
		expect(r.approval).toBeNull();
	});
});

describe("configuration servers", () => {
	const held = () => [
		{ id: "1", name: "home", baseUrl: "http://a:8787", token: "t1" },
		{ id: "2", name: "work", baseUrl: "http://b:8787", token: "t2" },
	];
	test("merge renames known addresses in place, adds new ones without a token, removes nothing", () => {
		const list = held();
		const first = list[0];
		mergeServers(list, [{ name: "Home", baseUrl: "http://a:8787" }, { name: "new", baseUrl: "http://c:8787" }]);
		expect(list[0]).toBe(first!);
		expect(list.map((s) => [s.name, s.token])).toEqual([["Home", "t1"], ["work", "t2"], ["new", ""]]);
	});
	test("replace keeps the document's list and order, ids and tokens of servers already held", () => {
		const out = replaceServers(held(), [{ name: "w", baseUrl: "http://b:8787" }, { name: "n", baseUrl: "http://c:8787" }]);
		expect(out.map((s) => s.name)).toEqual(["w", "n"]);
		expect(out[0]).toMatchObject({ id: "2", token: "t2" });
		expect(out[1]!.token).toBe("");
		expect(out[1]!.id).not.toBe("2");
	});
});

describe("idle extension stores", () => {
	const make = (open: string | null, apis: Record<string, unknown> = {}) => new IdleExtensionStores({ openId: () => open, apiOf: (id) => (apis[id] as never) ?? null });

	test("the open server and a server not attached have no idle editor", () => {
		const idle = make("s1");
		expect(idle.of("s1")).toBeNull();
		expect(idle.of("s2")).toBeNull();
		expect(idle.of(null)).toBeNull();
	});
	test("attaching the open server, or one with no connection, does nothing", async () => {
		const idle = make("s1", {});
		await idle.attach("s1");
		await idle.attach("gone");
		expect(idle.tick).toBe(0);
	});
	test("dropping what was never attached resolves and changes nothing", async () => {
		const idle = make("s1");
		await idle.drop("s2");
		idle.handOver("s2");
		await idle.settled;
		expect(idle.tick).toBe(0);
	});
	test("another server's list is never the host's: no idle editor means no rows", () => {
		expect(make("s1").clientsOf("s2")).toEqual([]);
	});
});

describe("pairing flow", () => {
	const link = { baseUrl: "http://10.0.0.5:8787", code: "abcdefgh", name: "" };
	const make = () => {
		const added: unknown[] = [];
		return { added, flow: new PairingFlow({ add: (i) => (added.push(i), true), toast: () => {} }) };
	};

	test("a link only asks first: nothing is added before the user confirms", () => {
		const { flow, added } = make();
		flow.connect(link);
		expect(JSON.parse(JSON.stringify(flow.linking))).toEqual({ name: "10.0.0.5:8787", baseUrl: link.baseUrl, state: "confirm" });
		expect(added).toEqual([]);
	});
	test("the same code is taken once, until declining frees it", () => {
		const { flow } = make();
		flow.connect(link);
		flow.close();
		expect(flow.linking).toBeNull();
		flow.connect(link);
		expect(flow.linking?.state).toBe("confirm");
		flow.connect({ ...link, name: "other" }); // same code while the card is up: ignored
		expect(flow.linking?.name).toBe("10.0.0.5:8787");
	});
	test("confirming with no pending link does nothing", async () => {
		const { flow, added } = make();
		await flow.confirm();
		expect(flow.linking).toBeNull();
		expect(added).toEqual([]);
	});
});
});

describe("close guard", () => {
	const local = { id: "pc", name: "", baseUrl: "http://127.0.0.1:1", token: "t", local: true };
	const make = (o: { local?: typeof local; busy?: string[]; api?: unknown } = {}) => {
		const aborted: string[] = [];
		const api = "api" in o ? o.api : { abort: async (id: string) => void aborted.push(id) };
		const guard = new CloseGuard({ local: () => ("local" in o ? o.local : local), openId: () => "pc", openApi: () => api as never, busyIds: () => o.busy ?? [] });
		return { guard, aborted };
	};

	test("closes at once without a local server, without a connection, or with nothing running", async () => {
		expect(await make({ local: undefined }).guard.request()).toBe(true);
		expect(await make({ api: null, busy: ["a"] }).guard.request()).toBe(true);
		expect(await make({ busy: [] }).guard.request()).toBe(true);
	});
	test("running work asks; a second ask while it is open is refused; cancel keeps the window", async () => {
		const { guard, aborted } = make({ busy: ["a", "b"] });
		const first = guard.request();
		expect(guard.confirm?.count).toBe(2);
		expect(await guard.request()).toBe(false);
		guard.confirm!.cancel();
		expect(await first).toBe(false);
		expect(guard.confirm).toBeNull();
		expect(aborted).toEqual([]);
	});
	test("confirming stops every busy session, then lets the window close", async () => {
		const { guard, aborted } = make({ busy: ["a", "b"] });
		const asked = guard.request();
		guard.confirm!.confirm();
		expect(await asked).toBe(true);
		expect(aborted).toEqual(["a", "b"]);
		expect(guard.confirm).toBeNull();
	});
});
