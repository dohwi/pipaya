import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { MAX_MESSAGE_SCROLL, messageScroll, setMessageScroll } from "../src/lib/chat-scroll";
import {
	claimMemoryDraft,
	forgetMemoryDraft,
	MAX_MEMORY_DRAFTS,
	memoryDrafts,
	releaseMemoryDraft,
	setMemoryDraft,
} from "../src/lib/composer/memory-drafts";
import { clearStarCache, fetchStars, STAR_FAIL_TTL } from "../src/lib/extensions/marketplace";
import { forgetServerGraphPins, GRAPH_PINS_KEY, onGraphPinForgotten, readGraphPins, writeGraphPins } from "../src/lib/graph-pins";
import {
	clearIconImageCache,
	loadIconImage,
	MAX_ICON_CACHE,
	peekIconImage,
	revokeServerIconImages,
} from "../src/lib/model-icon-image";
import {
	forgetServerWorkspaceTabs,
	MAX_STORED_WORKSPACE_DIRS,
	readStoredWorkspaceTabs,
	WORKSPACE_TABS_KEY,
	writeStoredWorkspaceTabs,
} from "../src/lib/workspace-tabs";
import type { FileDraft } from "../src/lib/files";
import type { WorkspaceViewerStore as WorkspaceViewerStoreType } from "../src/lib/workspace-viewer.svelte";

function makeMemoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		clear() { map.clear(); },
		getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
		key(i: number) { return [...map.keys()][i] ?? null; },
		removeItem(k: string) { map.delete(k); },
		setItem(k: string, v: string) { map.set(k, String(v)); },
	};
}

function fakeFileDraft(id: string, preview?: string): FileDraft {
	return {
		id,
		file: new File(["hello"], `${id}.png`, { type: "image/png" }),
		name: `${id}.png`,
		size: 5,
		mimeType: "image/png",
		...(preview ? { preview } : {}),
	};
}

let WorkspaceViewerStore: typeof WorkspaceViewerStoreType;
let buildDir: string;

beforeAll(async () => {
	buildDir = await mkdtemp(join(tmpdir(), "pipaya-ws-viewer-test-"));
	const libDir = resolve(import.meta.dir, "../src/lib");
	const srcPath = join(libDir, "workspace-viewer.svelte.ts");
	const build = await Bun.build({
		entrypoints: [srcPath],
		target: "bun",
		plugins: [
			{
				name: "svelte-runes-ts",
				setup(builder) {
					builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
						const raw = await Bun.file(path).text();
						const source = ts.transpileModule(raw, {
							compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
						}).outputText;
						return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
					});
				},
			},
		],
	});
	const out = join(buildDir, "workspace-viewer.mjs");
	await writeFile(out, await build.outputs[0]!.text());
	({ WorkspaceViewerStore } = (await import(out)) as { WorkspaceViewerStore: typeof WorkspaceViewerStoreType });
});

afterAll(async () => {
	if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

let prevLocalStorage: Storage | undefined;
let prevFetch: typeof globalThis.fetch;

beforeEach(() => {
	prevLocalStorage = globalThis.localStorage;
	prevFetch = globalThis.fetch;
	Object.defineProperty(globalThis, "localStorage", { value: makeMemoryStorage(), configurable: true, writable: true });
	memoryDrafts.clear();
	messageScroll.clear();
	clearIconImageCache();
	clearStarCache();
});

afterEach(() => {
	if (prevLocalStorage === undefined) {
		delete (globalThis as { localStorage?: Storage }).localStorage;
	} else {
		Object.defineProperty(globalThis, "localStorage", { value: prevLocalStorage, configurable: true, writable: true });
	}
	globalThis.fetch = prevFetch;
	memoryDrafts.clear();
	messageScroll.clear();
	clearIconImageCache();
	clearStarCache();
});

describe("memory-drafts blob URL cleanup & LRU cap", () => {
	test("releaseMemoryDraft and forgetMemoryDraft revoke preview blob URLs", () => {
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		try {
			setMemoryDraft("hygiene-s1", { text: "a", attachments: [], files: [fakeFileDraft("f1", "blob:p1"), fakeFileDraft("f2")], reply: null });
			setMemoryDraft("hygiene-s2", { text: "b", attachments: [], files: [fakeFileDraft("f3", "blob:p3")], reply: null });

			releaseMemoryDraft("hygiene-s1");
			expect(memoryDrafts.has("hygiene-s1")).toBe(false);
			expect(revoke.mock.calls).toEqual([["blob:p1"]]);

			// Releasing absent or empty keys is a safe no-op.
			releaseMemoryDraft("hygiene-s1");
			forgetMemoryDraft("");
			expect(revoke.mock.calls).toHaveLength(1);

			forgetMemoryDraft("hygiene-s2");
			expect(memoryDrafts.has("hygiene-s2")).toBe(false);
			expect(revoke.mock.calls).toEqual([["blob:p1"], ["blob:p3"]]);
		} finally {
			revoke.mockRestore();
		}
	});

	test("setMemoryDraft enforces MAX_MEMORY_DRAFTS, revokes evicted previews, and never evicts a mounted draft", () => {
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const unclaimMounted = claimMemoryDraft("s-0");
		try {
			for (let i = 0; i < MAX_MEMORY_DRAFTS + 5; i++) {
				setMemoryDraft(`s-${i}`, {
					text: `draft ${i}`,
					attachments: [],
					files: [fakeFileDraft(`f-${i}`, `blob:draft-${i}`)],
					reply: null,
				});
			}
			expect(memoryDrafts.size).toBe(MAX_MEMORY_DRAFTS);
			// s-0 is actively mounted in a live Composer pane so it must survive eviction with its preview intact.
			expect(memoryDrafts.has("s-0")).toBe(true);
			expect(memoryDrafts.has("s-1")).toBe(false);
			expect(memoryDrafts.has(`s-${MAX_MEMORY_DRAFTS + 4}`)).toBe(true);
			expect(revoke.mock.calls.map((c) => c[0])).toEqual(["blob:draft-1", "blob:draft-2", "blob:draft-3", "blob:draft-4", "blob:draft-5"]);

			// Once unclaimed, s-0 becomes eligible for normal eviction.
			unclaimMounted();
			setMemoryDraft("s-after", { text: "after", attachments: [], files: [], reply: null });
			expect(memoryDrafts.has("s-0")).toBe(false);
			expect(revoke.mock.calls.at(-1)).toEqual(["blob:draft-0"]);
		} finally {
			unclaimMounted();
			revoke.mockRestore();
		}
	});
});

describe("chat-scroll LRU cap", () => {
	test("setMessageScroll bounds map size and refreshes LRU order", () => {
		setMessageScroll("", 100);
		expect(messageScroll.size).toBe(0);

		for (let i = 0; i < MAX_MESSAGE_SCROLL; i++) setMessageScroll(`s-${i}`, i);
		setMessageScroll("s-0", 999);
		setMessageScroll("s-new", 42);
		expect(messageScroll.size).toBe(MAX_MESSAGE_SCROLL);
		expect(messageScroll.get("s-0")).toBe(999);
		expect(messageScroll.has("s-1")).toBe(false);
		expect(messageScroll.get("s-new")).toBe(42);
	});
});

describe("model-icon-image LRU cap & server revocation", () => {
	test("evicts oldest blob URL past MAX_ICON_CACHE and revokes only removed server on revokeServerIconImages", async () => {
		let seq = 0;
		const create = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:icon-${++seq}`);
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;

		try {
			const connA = { baseUrl: "http://a.test", token: "ta" };
			const connB = { baseUrl: "http://b.test", token: "tb" };

			const a0 = await loadIconImage(connA, "img:0");
			const b0 = await loadIconImage(connB, "img:0");
			expect(a0).toBe("blob:icon-1");
			expect(b0).toBe("blob:icon-2");

			revokeServerIconImages(connA.baseUrl);
			expect(peekIconImage(connA, "img:0")).toBeNull();
			expect(peekIconImage(connB, "img:0")).toBe("blob:icon-2");
			expect(revoke.mock.calls).toEqual([["blob:icon-1"]]);

			for (let i = 1; i <= MAX_ICON_CACHE; i++) {
				await loadIconImage(connB, `img:${i}`);
			}
			expect(peekIconImage(connB, "img:0")).toBeNull();
			expect(revoke.mock.calls.some((c) => c[0] === "blob:icon-2")).toBe(true);
		} finally {
			create.mockRestore();
			revoke.mockRestore();
		}
	});

	test("revoking a server while its fetch is in-flight revokes the late blob URL without cancelling other servers", async () => {
		let seq = 0;
		const create = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:inflight-${++seq}`);
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const gateA = Promise.withResolvers<Response>();
		const gateB = Promise.withResolvers<Response>();
		globalThis.fetch = ((input: string | URL | Request) => {
			const url = String(input);
			return url.startsWith("http://a.test") ? gateA.promise : gateB.promise;
		}) as unknown as typeof fetch;

		try {
			const connA = { baseUrl: "http://a.test", token: "ta" };
			const connB = { baseUrl: "http://b.test", token: "tb" };
			const pA = loadIconImage(connA, "img:late");
			const pB = loadIconImage(connB, "img:keep");

			revokeServerIconImages(connA.baseUrl);
			gateA.resolve(new Response(new Uint8Array([1]), { status: 200 }));
			gateB.resolve(new Response(new Uint8Array([2]), { status: 200 }));

			expect(await pA).toBeNull();
			expect(await pB).toBe("blob:inflight-2");
			expect(revoke.mock.calls).toEqual([["blob:inflight-1"]]);
			expect(peekIconImage(connB, "img:keep")).toBe("blob:inflight-2");
		} finally {
			create.mockRestore();
			revoke.mockRestore();
		}
	});
});

describe("marketplace star cache TTL, negative caching & pruning", () => {
	test("rate-limited failures respect STAR_FAIL_TTL, stale localStorage entries survive for fallback, and >7d entries are pruned", async () => {
		const baseNow = Date.now();
		let fakeNow = baseNow;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);

		localStorage.setItem(
			"pipaya.marketplace.stars",
			JSON.stringify({
				"ancient/repo": { n: 5, at: baseNow - 8 * 24 * 3600_000 },
				"stale-fallback/repo": { n: 77, at: baseNow - 2 * 3600_000 },
				"fresh/repo": { n: 42, at: baseNow - 60_000 },
			}),
		);

		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls <= 2) return new Response("rate limited", { status: 403 });
			return new Response(JSON.stringify({ stargazers_count: 99 }), { status: 200 });
		}) as unknown as typeof fetch;

		try {
			// Stale (>1h, <7d) entry still serves as fallback when GitHub returns 403.
			expect(await fetchStars("stale-fallback/repo")).toBe(77);
			expect(calls).toBe(1);

			// Uncached failing repo caches undefined for STAR_FAIL_TTL so immediate repeats do not hammer GitHub.
			expect(await fetchStars("new/repo")).toBeUndefined();
			expect(await fetchStars("new/repo")).toBeUndefined();
			expect(calls).toBe(2);

			// After STAR_FAIL_TTL expires, it retries and succeeds, pruning >7d "ancient/repo" while keeping fallback entries.
			fakeNow = baseNow + STAR_FAIL_TTL + 1000;
			expect(await fetchStars("new/repo")).toBe(99);
			expect(calls).toBe(3);

			const stored = JSON.parse(localStorage.getItem("pipaya.marketplace.stars") || "{}") as Record<string, { n: number; at: number }>;
			expect(stored["ancient/repo"]).toBeUndefined();
			expect(stored["stale-fallback/repo"]?.n).toBe(77);
			expect(stored["fresh/repo"]?.n).toBe(42);
			expect(stored["new/repo"]?.n).toBe(99);
		} finally {
			nowSpy.mockRestore();
		}
	});
});

describe("graph-pins & workspace-tabs per-server cleanup and caps", () => {
	test("forgetServerGraphPins drops session, server, and role pins for the removed server only", () => {
		writeGraphPins({
			"s:srv1/a": { x: 1, y: 2 },
			"v:srv1": { x: 2, y: 3 },
			"r:srv1/system": { x: 3, y: 4 },
			"s:srv2/a": { x: 5, y: 6 },
			"v:srv2": { x: 6, y: 7 },
			"m:model": { x: 7, y: 8 },
		});
		const forgotten: string[] = [];
		const off = onGraphPinForgotten((k) => forgotten.push(k));
		try {
			forgetServerGraphPins("srv1");
			expect(forgotten.sort()).toEqual(["r:srv1/system", "s:srv1/a", "v:srv1"]);
			expect(readGraphPins()).toEqual({
				"s:srv2/a": { x: 5, y: 6 },
				"v:srv2": { x: 6, y: 7 },
				"m:model": { x: 7, y: 8 },
			});
			expect(JSON.parse(localStorage.getItem(GRAPH_PINS_KEY) || "{}")).toEqual({
				"s:srv2/a": { x: 5, y: 6 },
				"v:srv2": { x: 6, y: 7 },
				"m:model": { x: 7, y: 8 },
			});
		} finally {
			off();
		}
	});

	test("writeStoredWorkspaceTabs caps directories and WorkspaceViewerStore.forgetServer prevents write-back when removing the open server", () => {
		for (let i = 0; i < MAX_STORED_WORKSPACE_DIRS + 3; i++) {
			writeStoredWorkspaceTabs(`http://srv1\0/dir-${i}`, [`file-${i}.ts`]);
		}
		expect(readStoredWorkspaceTabs("http://srv1\0/dir-0")).toEqual([]);
		expect(readStoredWorkspaceTabs(`http://srv1\0/dir-${MAX_STORED_WORKSPACE_DIRS + 2}`)).toEqual([
			`file-${MAX_STORED_WORKSPACE_DIRS + 2}.ts`,
		]);

		// Simulate removing the currently-open server: forgetServer clears storage + live state so subsequent bind()
		// to another server (or null) does NOT write the removed server's tabs back.
		const viewer = new WorkspaceViewerStore();
		const fakeApi1 = {
			baseUrl: "http://open-srv",
			workspaceTree: async () => ({ root: "/proj", isRepo: false, branch: null, head: null, entries: [] }),
			workspaceChanges: async () => ({ root: "/proj", isRepo: false, branch: null, head: null, changes: [] }),
		};
		const fakeApi2 = {
			baseUrl: "http://next-srv",
			workspaceTree: async () => ({ root: "/other", isRepo: false, branch: null, head: null, entries: [] }),
			workspaceChanges: async () => ({ root: "/other", isRepo: false, branch: null, head: null, changes: [] }),
		};
		writeStoredWorkspaceTabs("http://open-srv\0/proj", ["README.md"]);
		viewer.bind(fakeApi1 as never, "sess1", "/proj");
		expect(viewer.openFiles).toEqual(["README.md"]);

		viewer.forgetServer("http://open-srv");
		expect(readStoredWorkspaceTabs("http://open-srv\0/proj")).toEqual([]);
		expect(viewer.openFiles).toEqual([]);

		// Re-binding to the next server (or closing to null) must NOT resurrect http://open-srv\0/proj.
		viewer.bind(fakeApi2 as never, "sess2", "/other");
		expect(readStoredWorkspaceTabs("http://open-srv\0/proj")).toEqual([]);
		viewer.bind(null, null, "");
		expect(readStoredWorkspaceTabs("http://open-srv\0/proj")).toEqual([]);

		forgetServerWorkspaceTabs("http://srv1");
		expect(localStorage.getItem(WORKSPACE_TABS_KEY)).toBeNull();
	});
});
