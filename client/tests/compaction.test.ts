import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { Api, ApiError } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import type { PipayaEvent } from "../src/lib/types";

let ChatState: typeof ChatStateType;
let dir: string;
beforeAll(async () => {
	// Compile the real rune module with Svelte, rather than substituting fake $state globals.
	dir = await mkdtemp(join(tmpdir(), "pipaya-compaction-"));
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/chat.svelte.ts")], target: "bun",
		plugins: [{ name: "runes", setup(builder) {
			builder.onResolve({ filter: /\/src\/lib\/api\.ts$/ }, ({ path }) => ({ path, external: true }));
			builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
				const source = ts.transpileModule(await Bun.file(path).text(), {
					compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
				}).outputText;
				return { contents: compileModule(source.replace('from "./api"', `from ${JSON.stringify(resolve("src/lib/api.ts"))}`), { filename: path, generate: "client" }).js.code, loader: "js" };
			});
		} }],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "chat.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	ChatState = (await import(file)).ChatState;
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const context = { tokens: 1000, contextWindow: 128000 };
const result = { tokensBefore: 80000, context };
function setup(overrides: Record<string, unknown> = {}) {
	const api = {
		messages: async () => [], tailMessages: async () => [], approvals: async () => [], questions: async () => [],
		getSession: async () => ({ status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: false }, context, compaction: { supported: true, autoEnabled: true }, usage: {} }),
		compactSession: async () => result,
		...overrides,
	};
	return { chat: new ChatState("session", api as unknown as Api), api };
}
const event = (type: string, data: unknown = {}): PipayaEvent => ({ id: 1, sessionId: "session", type, data, ts: Date.now() });

describe("pi compaction state", () => {
	test("reload restores server compaction and unknown context", async () => {
		const { chat } = setup({ getSession: async () => ({ status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: true }, context: { ...context, tokens: null }, compaction: { supported: true, autoEnabled: true } }) });
		await chat.load();
		expect(chat.compacting).toBe(true);
		expect(chat.context?.tokens).toBeNull();
		expect(chat.compaction?.autoEnabled).toBe(true);
	});

	test("completion arriving during reload is replayed after the snapshot", async () => {
		let complete!: (value: unknown) => void;
		const { chat } = setup({ getSession: () => new Promise((r) => { complete = r; }) });
		const load = chat.load();
		chat.apply(event("compaction_finished", { context: { ...context, tokens: 900 } }));
		complete({ context: { ...context, tokens: 80000 }, status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: true } });
		await load;
		expect(chat.compacting).toBe(false);
		expect(chat.context?.tokens).toBe(900);
	});

	test("old servers remain loadable without new fields", async () => {
		const { chat } = setup({ getSession: async () => ({ status: { running: false, pendingToolCalls: [], streamingMessage: null } }) });
		await chat.load();
		expect(chat.ready).toBe(true);
		expect(chat.context).toBeUndefined();
		expect(chat.compacting).toBe(false);
	});

	test("manual request blocks duplicates and retains transcript", async () => {
		let finish!: (value: typeof result) => void;
		let calls = 0;
		const { chat } = setup({ compactSession: () => { calls++; return new Promise((r) => { finish = r; }); } });
		chat.addOptimisticUser("keep original history", []);
		const request = chat.compact("preserve decisions");
		expect(chat.compacting).toBe(true);
		await expect(chat.compact()).rejects.toThrow("작업이 끝난 뒤");
		finish(result);
		await request;
		expect(calls).toBe(1);
		expect(chat.compacting).toBe(false);
		expect(chat.context?.tokens).toBe(1000);
		expect(chat.items[0]?.kind).toBe("user");
	});

	test("cannot compact during an agent run", async () => {
		const { chat } = setup();
		chat.apply(event("run_started"));
		await expect(chat.compact()).rejects.toThrow("작업이 끝난 뒤");
	});

	test("finished SSE context wins over stale HTTP response", async () => {
		let finish!: (value: typeof result) => void;
		const { chat } = setup({ compactSession: () => new Promise((r) => { finish = r; }), getSession: async () => { throw new Error("offline"); } });
		const request = chat.compact();
		chat.apply(event("compaction_started"));
		chat.apply(event("compaction_finished", { context: { ...context, tokens: null } }));
		finish(result);
		await request;
		expect(chat.compacting).toBe(false);
		expect(chat.context?.tokens).toBeNull();
	});

	test("a snapshot started before compaction cannot overwrite completed context", async () => {
		let finishSnapshot!: (value: unknown) => void;
		let snapshots = 0;
		const { chat } = setup({ getSession: () => {
			if (++snapshots === 1) return new Promise((r) => { finishSnapshot = r; });
			throw new Error("offline");
		} });
		const refresh = chat.refreshContext();
		await chat.compact();
		finishSnapshot({ context: { ...context, tokens: 80000 }, status: { compacting: false } });
		await refresh;
		expect(chat.context?.tokens).toBe(1000);
	});

	test("only the latest requested context snapshot is applied", async () => {
		const completions: ((value: unknown) => void)[] = [];
		const { chat } = setup({ getSession: () => new Promise((r) => { completions.push(r); }) });
		const first = chat.refreshContext();
		const second = chat.refreshContext();
		completions[1]!({ context, status: { compacting: false } });
		await second;
		completions[0]!({ context: { ...context, tokens: 80000 }, status: { compacting: true } });
		await first;
		expect(chat.context?.tokens).toBe(1000);
		expect(chat.compacting).toBe(false);
	});

	test("failure preserves context, exposes error, and does not retry", async () => {
		let calls = 0;
		const { chat } = setup({ compactSession: async () => { calls++; throw new Error("provider unavailable"); }, getSession: async () => { throw new Error("offline"); } });
		chat.context = context;
		await expect(chat.compact()).rejects.toThrow("provider unavailable");
		expect(chat.compacting).toBe(false);
		expect(chat.context?.tokens).toBe(1000);
		expect(chat.compactionError).toBe("provider unavailable");
		expect(calls).toBe(1);
	});

	test("unsupported endpoint has an explicit BE requirement, not a model prompt", async () => {
		const { chat } = setup({ compactSession: async () => { throw new ApiError(501, "compaction_not_supported", "unsupported"); } });
		await expect(chat.compact()).rejects.toThrow("BE 연동");
		expect(chat.items).toHaveLength(0);
		expect(chat.compacting).toBe(false);
	});

	test("new inputs keep the last measurement (no flash of an empty status line) until the next usage or context_updated", () => {
		const { chat } = setup();
		chat.context = context;
		chat.apply(event("message_end", { seq: 0, message: { role: "user", content: "new input", timestamp: 1 } }));
		expect(chat.context?.tokens).toBe(1000);
		chat.apply(event("message_end", { seq: 1, message: { role: "assistant", content: [], usage: { totalTokens: 1500 }, timestamp: 2 } as never }));
		expect(chat.context?.tokens).toBe(1500);
		chat.apply(event("context_updated", { context: { ...context, tokens: 1200 } }));
		expect(chat.context?.tokens).toBe(1200);
	});

	test("automatic compaction handles failure and cancellation without ending agent run", () => {
		const { chat } = setup();
		chat.apply(event("run_started"));
		chat.apply(event("compaction_started"));
		expect(chat.compacting).toBe(true);
		chat.apply(event("compaction_failed", { aborted: true }));
		expect(chat.compacting).toBe(false);
		expect(chat.running).toBe(true);
		expect(chat.compactionError).toContain("취소");
	});
});

describe("REST/SSE compaction contract", () => {
	test("POST sends custom instructions, never a user message", async () => {
		const original = globalThis.fetch;
		const requests: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			requests.push({ url: String(url), init });
			return new Response(JSON.stringify(result));
		}) as typeof fetch;
		try {
			const api = new Api({ baseUrl: "http://example.test", token: "secret" });
			expect(await api.compactSession("session", "  preserve files  ")).toEqual(result);
			expect(requests[0]?.url).toBe("http://example.test/sessions/session/compact");
			expect(requests[0]?.init?.method).toBe("POST");
			expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({ customInstructions: "preserve files" });
			await api.compactSession("session");
			expect(JSON.parse(requests[1]?.init?.body as string)).toEqual({});
		} finally { globalThis.fetch = original; }
	});

	test("subscribes to all compaction and context events", async () => {
		const original = globalThis.EventSource;
		const originalFetch = globalThis.fetch;
		const names: string[] = [];
		globalThis.EventSource = class {
			addEventListener(name: string) { names.push(name); }
			close() {}
		} as unknown as typeof EventSource;
		// The stream opens once the one-time ticket has arrived.
		globalThis.fetch = (async () => Response.json({ ticket: "t", expiresAt: 0 })) as unknown as typeof fetch;
		try {
			const api = new Api({ baseUrl: "http://example.test", token: "secret" });
			const stop = api.subscribe({ onEvent() {} }, 0);
			await Bun.sleep(0);
			stop();
			for (const name of ["compaction_started", "compaction_finished", "compaction_failed", "context_updated"]) expect(names).toContain(name);
		} finally { globalThis.EventSource = original; globalThis.fetch = originalFetch; }
	});
});

describe("ask_user questions", () => {
	const asked = { toolCallId: "c1", toolName: "ask_user", question: "Which one?", options: ["red", "blue"], allowFreeText: false };

	test("a question marks its tool call as waiting and keeps what was asked", async () => {
		const { chat } = setup();
		await chat.load();
		chat.apply(event("question_requested", { sessionId: "session", ...asked, requestedAt: 1 }));
		const run = chat.tools.c1!;
		expect(run.state).toBe("awaiting_input");
		expect(run.question?.question).toBe("Which one?");
		expect([...(run.question?.options ?? [])]).toEqual(["red", "blue"]);
		expect(run.question?.allowFreeText).toBe(false);
	});

	test("answering lets the tool run on and drops the question", async () => {
		const { chat } = setup();
		await chat.load();
		chat.apply(event("question_requested", { sessionId: "session", ...asked, requestedAt: 1 }));
		chat.apply(event("question_resolved", { toolCallId: "c1", answered: true, source: "user" }));
		expect(chat.tools.c1?.state).toBe("running");
		expect(chat.tools.c1?.question).toBeUndefined();
	});

	test("a question still open on the server is restored after a reload", async () => {
		const q = { sessionId: "session", ...asked, requestedAt: 1 };
		const { chat } = setup({ questions: async () => [q, { ...q, sessionId: "other", toolCallId: "c2" }] });
		await chat.load();
		expect(chat.tools.c1?.question?.question).toBe("Which one?");
		expect(chat.tools.c2).toBeUndefined();
	});
});

describe("paged transcript", () => {
	const stored = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ seq: from + i, role: "user", createdAt: 1, message: { role: "user", content: `m${from + i}`, timestamp: 1 } }));
	/** A server holding seq 0..999: the newest `n` below `before`, like the real `tail`. */
	const server = (calls: (number | undefined)[] = [], total = 1000) => async (_id: string, n: number, before?: number) => {
		calls.push(before);
		const end = before ?? total;
		return stored(Math.max(0, end - n), end);
	};
	const settle = () => new Promise((r) => setTimeout(r, 5));
	test("opens on the newest page and loads earlier ones in front", async () => {
		const calls: (number | undefined)[] = [];
		const { chat } = setup({ tailMessages: server(calls) });
		await chat.load();
		expect(chat.items).toHaveLength(40);
		expect(chat.hasEarlier).toBe(true);
		await chat.loadEarlier();
		expect(calls.slice(0, 2)).toEqual([undefined, 960]);
		expect(chat.items).toHaveLength(140);
		expect(chat.items[0]!.seq).toBe(860);
		expect(chat.hasEarlier).toBe(true);
	});
	test("the next older page is fetched ahead, once, and used when the reader gets there", async () => {
		const calls: (number | undefined)[] = [];
		const { chat } = setup({ tailMessages: server(calls) });
		await chat.load();
		await settle();
		expect(calls).toEqual([undefined, 960]);
		await chat.loadEarlier();
		expect(calls.slice(0, 2)).toEqual([undefined, 960]); // no second request for the same page
		await settle();
		expect(calls).toEqual([undefined, 960, 860]); // and the page after it is already on its way
	});
	test("a page stretched back to a reply's prompt (more than asked) still offers what is before it", async () => {
		const { chat } = setup({ tailMessages: async (_id: string, _n: number, before?: number) => (before === undefined ? stored(900, 1000) : stored(800, 900)) });
		await chat.load();
		expect(chat.items).toHaveLength(100);
		expect(chat.hasEarlier).toBe(true);
		await chat.loadEarlier();
		expect(chat.items[0]!.seq).toBe(800);
		expect(chat.hasEarlier).toBe(true);
	});
	test("a short conversation has nothing earlier", async () => {
		const { chat } = setup({ tailMessages: async () => stored(0, 5) });
		await chat.load();
		expect(chat.hasEarlier).toBe(false);
	});
	test("an old server that ignores tail and sends everything shows no earlier button", async () => {
		const { chat } = setup({ tailMessages: async () => stored(0, 1900) });
		await chat.load();
		expect(chat.items).toHaveLength(1900);
		expect(chat.hasEarlier).toBe(false);
	});
	test("a failed earlier fetch keeps the loaded messages and the button, and retries later", async () => {
		let fail = false;
		const ok = server();
		const { chat } = setup({ tailMessages: async (id: string, n: number, before?: number) => { if (fail && before !== undefined) throw new Error("offline"); return ok(id, n, before); } });
		fail = true;
		await chat.load();
		await settle();
		await chat.loadEarlier();
		expect(chat.items).toHaveLength(40);
		expect(chat.hasEarlier).toBe(true);
		expect(chat.loadingEarlier).toBe(false);
		fail = false;
		await chat.loadEarlier();
		expect(chat.items).toHaveLength(140);
	});
	test("the reader's position is measured when the page lands, not when the request left", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const ok = server();
		const { chat } = setup({ tailMessages: async (id: string, n: number, before?: number) => { if (before !== undefined) await gate; return ok(id, n, before); } });
		await chat.load();
		const order: string[] = [];
		const pending = chat.loadEarlier(() => order.push(`insert@${chat.items.length}`));
		order.push("scrolled meanwhile");
		release();
		await pending;
		expect(order).toEqual(["scrolled meanwhile", "insert@40"]);
		expect(chat.items).toHaveLength(140);
	});
});
