import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type * as SidebarModule from "../src/lib/sidebar.svelte";
import { forgetGraphPin, GRAPH_PINS_KEY, graphSessionPinKey, onGraphPinForgotten, readGraphPins, writeGraphPins } from "../src/lib/graph-pins";
import { forgetMemoryDraft, isDraftForgotten, memoryDrafts } from "../src/lib/composer/memory-drafts";
import { forgetMessageScroll, messageScroll } from "../src/lib/chat-scroll";
import type * as EventHandlerModule from "../src/lib/store/event-handler";
import type { OpenEventContext } from "../src/lib/store/event-handler";
import type { PipayaEvent, Session } from "../src/lib/types";

let SidebarState: typeof SidebarModule.SidebarState;
let handleOpenServerEvent: typeof EventHandlerModule.handleOpenServerEvent;
let cueBackgroundEvent: typeof EventHandlerModule.cueBackgroundEvent;
let dir: string;

function makeStorage() {
	const map = new Map<string, string>();
	return {
		map,
		storage: {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => { map.set(k, String(v)); },
			removeItem: (k: string) => { map.delete(k); },
		},
	};
}

async function loadCompiled(relPath: string, outName: string) {
	const build = await Bun.build({
		entrypoints: [resolve(relPath)],
		target: "bun",
		plugins: [{
			name: "runes",
			setup(builder) {
				builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
					const source = ts.transpileModule(await Bun.file(path).text(), {
						compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
					}).outputText;
					return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
				});
			},
		}],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, `${outName}.mjs`);
	await writeFile(file, await build.outputs[0]!.text());
	return import(file);
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-session-cleanup-"));
	(globalThis as any).localStorage ??= makeStorage().storage;
	(globalThis as any).sessionStorage ??= makeStorage().storage;
	({ SidebarState } = await loadCompiled("src/lib/sidebar.svelte.ts", "sidebar"));
	({ handleOpenServerEvent, cueBackgroundEvent } = await loadCompiled("src/lib/store/event-handler.ts", "event-handler"));
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("SidebarState unpinTab & forgetTab", () => {
	test("unpinTab removes only the closed session's pin while preserving tabOrder", () => {
		const { map, storage } = makeStorage();
		const prev = (globalThis as any).localStorage;
		(globalThis as any).localStorage = storage;
		try {
			const sb = new SidebarState();
			const edits: string[] = [];
			sb.onEdit = (sid) => edits.push(sid);
			sb.pinnedTabs = { s1: ["a", "b"], s2: ["a"] };
			sb.tabOrder = { s1: ["a", "b", "c"] };

			// no-op for unpinned, empty, or unknown server
			sb.unpinTab("s1", "c");
			sb.unpinTab("s1", "");
			sb.unpinTab("", "a");
			sb.unpinTab("missing", "a");
			expect(edits).toEqual([]);

			sb.unpinTab("s1", "a");
			expect(sb.pinnedTabs).toEqual({ s1: ["b"], s2: ["a"] });
			expect(sb.tabOrder).toEqual({ s1: ["a", "b", "c"] });
			expect(edits).toEqual(["s1"]);
			expect(JSON.parse(map.get("pipaya.pinnedtabs")!)).toEqual({ s1: ["b"], s2: ["a"] });

			// removing last pinned tab drops the empty server entry
			sb.unpinTab("s1", "b");
			expect(sb.pinnedTabs).toEqual({ s2: ["a"] });
			expect(edits).toEqual(["s1", "s1"]);

			// idempotent on repeat
			sb.unpinTab("s1", "b");
			expect(edits).toEqual(["s1", "s1"]);
		} finally {
			(globalThis as any).localStorage = prev;
		}
	});

	test("forgetTab cleans pinnedTabs, tabOrder, groupDir, and folded with minimal edits", () => {
		const { map, storage } = makeStorage();
		const prev = (globalThis as any).localStorage;
		(globalThis as any).localStorage = storage;
		try {
			const sb = new SidebarState();
			const edits: string[] = [];
			sb.onEdit = (sid) => edits.push(sid);
			sb.pinnedTabs = { s1: ["g1", "a"] };
			sb.tabOrder = { s1: ["g1", "a"] };
			sb.groupDir = { s1: { g1: "/repo", g2: "/other" } };
			sb.folded = ["group\u0000g1", "group\u0000g2", "s1"];

			sb.forgetTab("s1", "g1");
			expect(sb.pinnedTabs).toEqual({ s1: ["a"] });
			expect(sb.tabOrder).toEqual({ s1: ["a"] });
			expect(sb.groupDir).toEqual({ s1: { g2: "/other" } });
			expect(sb.folded).toEqual(["group\u0000g2", "s1"]);
			expect(edits).toEqual(["s1"]);
			expect(JSON.parse(map.get("pipaya.folded")!)).toEqual(["group\u0000g2", "s1"]);

			// repeat call is a no-op
			sb.forgetTab("s1", "g1");
			expect(edits).toEqual(["s1"]);

			// device-local folded entry alone does not trigger server sync onEdit
			sb.forgetTab("s1", "g2");
			expect(sb.groupDir).toEqual({});
			expect(sb.folded).toEqual(["s1"]);
			expect(edits).toEqual(["s1", "s1"]);

			sb.folded = ["group\u0000only-folded"];
			sb.forgetTab("s1", "only-folded");
			expect(sb.folded).toEqual([]);
			expect(edits).toEqual(["s1", "s1"]);
		} finally {
			(globalThis as any).localStorage = prev;
		}
	});
});

describe("graph pins cleanup", () => {
	test("forgetGraphPin removes only the target session pin and notifies live listeners", () => {
		const { map, storage } = makeStorage();
		const prev = (globalThis as any).localStorage;
		(globalThis as any).localStorage = storage;
		try {
			const k1 = graphSessionPinKey("s1", "sess-1");
			const k2 = graphSessionPinKey("s1", "sess-2");
			writeGraphPins({ [k1]: { x: 10, y: 20 }, [k2]: { x: 30, y: 40 }, "m:s1/p/mod": { x: 1, y: 2 } });
			const heard: string[] = [];
			const off = onGraphPinForgotten((k) => heard.push(k));

			forgetGraphPin("s1", "sess-1");
			expect(readGraphPins()).toEqual({ [k2]: { x: 30, y: 40 }, "m:s1/p/mod": { x: 1, y: 2 } });
			expect(heard).toEqual([k1]);

			off();
			forgetGraphPin("s1", "sess-2");
			expect(heard).toEqual([k1]);
			expect(readGraphPins()).toEqual({ "m:s1/p/mod": { x: 1, y: 2 } });

			// corrupt JSON and empty inputs never throw
			map.set(GRAPH_PINS_KEY, "{broken");
			expect(readGraphPins()).toEqual({});
			expect(() => forgetGraphPin("", "sess-1")).not.toThrow();
			expect(() => forgetGraphPin("s1", "")).not.toThrow();
		} finally {
			(globalThis as any).localStorage = prev;
		}
	});
});

describe("in-memory composer drafts and message scroll cleanup", () => {
	test("forgetMemoryDraft and forgetMessageScroll clear only the deleted session and protect empty keys", () => {
		memoryDrafts.clear();
		messageScroll.clear();
		memoryDrafts.set("", { text: "new chat", attachments: [], files: [], reply: null });
		memoryDrafts.set("s1", { text: "hello", attachments: [], files: [], reply: null });
		messageScroll.set("s1", 240);
		messageScroll.set("s2", 100);

		forgetMemoryDraft("");
		forgetMemoryDraft("s1");
		forgetMessageScroll("");
		forgetMessageScroll("s1");

		expect(memoryDrafts.has("")).toBe(true);
		expect(memoryDrafts.has("s1")).toBe(false);
		expect(isDraftForgotten("")).toBe(false);
		expect(isDraftForgotten("s1")).toBe(true);
		expect(isDraftForgotten("s2")).toBe(false);
		expect(messageScroll.has("s1")).toBe(false);
		expect(messageScroll.get("s2")).toBe(100);
	});
});

describe("handleOpenServerEvent lifecycle cleanup callbacks", () => {
	function makeCtx() {
		const closed: string[] = [];
		const deleted: string[] = [];
		const groupsDeleted: string[] = [];
		const fullDropped: string[] = [];
		let sessions: Session[] = [{ id: "a", title: "A", cwd: "/p", closed: false } as Session];
		let groups = [{ id: "g1", name: "G", layout: { kind: "pane", sessionId: "a" }, createdAt: 1, updatedAt: 1 }] as any[];
		const ctx: OpenEventContext = {
			activeId: null,
			quietPeers: true,
			get sessions() { return sessions; },
			get groups() { return groups; },
			terminals: [],
			running: {},
			compacting: {},
			awaiting: {},
			unread: {},
			failed: {},
			chats: {},
			setSessions: (next) => { sessions = next; },
			setGroups: (next) => { groups = next; },
			setToolsInfo: () => {},
			setWorkdirInfo: () => {},
			neighbourOf: () => undefined,
			forgetInGroups: () => {},
			leave: () => {},
			dropFull: (id) => { fullDropped.push(id); },
			dropTerminal: () => {},
			onSessionClosed: (id) => { closed.push(id); },
			onSessionDeleted: (id) => { deleted.push(id); },
			onGroupDeleted: (id) => { groupsDeleted.push(id); },
			cue: () => {},
			announce: () => {},
			bumpSkills: () => {},
			bumpMcp: () => {},
			bumpSchedules: () => {},
			bumpGoals: () => {},
			bumpConfig: () => {},
			bumpVoice: () => {},
			refreshWorkspace: () => {},
			refreshProviders: () => {},
			refreshServerExtensions: () => {},
			refreshActivity: () => {},
			syncLocales: () => {},
			onClientSettings: () => {},
			refreshUsage: () => {},
			flushHeld: () => {},
		};
		return { ctx, closed, deleted, groupsDeleted, fullDropped };
	}

	test("fires onSessionClosed only when closed=true, plus onSessionDeleted and onGroupDeleted", () => {
		const { ctx, closed, deleted, groupsDeleted, fullDropped } = makeCtx();
		handleOpenServerEvent(ctx, { type: "session_updated", sessionId: "a", ts: 1, data: { id: "a", title: "Renamed", closed: false } } as unknown as PipayaEvent);
		expect(closed).toEqual([]);

		handleOpenServerEvent(ctx, { type: "session_updated", sessionId: "a", ts: 2, data: { id: "a", title: "Renamed", closed: true } } as unknown as PipayaEvent);
		expect(closed).toEqual(["a"]);

		handleOpenServerEvent(ctx, { type: "session_deleted", sessionId: null, ts: 3, data: { id: "a" } } as unknown as PipayaEvent);
		expect(deleted).toEqual(["a"]);

		handleOpenServerEvent(ctx, { type: "group_deleted", sessionId: null, ts: 4, data: { id: "g1" } } as unknown as PipayaEvent);
		expect(groupsDeleted).toEqual(["g1"]);
		expect(fullDropped).toEqual(["g1"]);
	});

	test("cueBackgroundEvent suppresses ok done cue while an active goal is running, but still reports errors", () => {
		const cues: string[] = [];
		const announced: string[] = [];
		const link = { id: "srv-bg", data: { awaiting: {} } } as unknown as Parameters<typeof cueBackgroundEvent>[0];
		const cb = {
			cue: (k: "done" | "failed" | "ask") => cues.push(k),
			announce: (sid: string, k: "done" | "failed", srv: string) => announced.push(`${srv}:${sid}:${k}`),
			isGoalActive: (sid: string) => sid === "active-goal-session",
		};
		cueBackgroundEvent(link, { type: "run_finished", sessionId: "active-goal-session", ts: 1, data: { status: "ok", origin: "goal" } } as unknown as PipayaEvent, cb);
		expect(cues).toEqual([]);
		expect(announced).toEqual([]);

		cueBackgroundEvent(link, { type: "run_finished", sessionId: "active-goal-session", ts: 2, data: { status: "error", origin: "goal" } } as unknown as PipayaEvent, cb);
		expect(cues).toEqual(["failed"]);
		expect(announced).toEqual(["srv-bg:active-goal-session:failed"]);

		cueBackgroundEvent(link, { type: "run_finished", sessionId: "normal", ts: 3, data: { status: "ok", origin: "user" } } as unknown as PipayaEvent, cb);
		expect(cues).toEqual(["failed", "done"]);
		expect(announced).toEqual(["srv-bg:active-goal-session:failed", "srv-bg:normal:done"]);
	});
});
