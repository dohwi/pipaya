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
		messages: async () => [], approvals: async () => [], questions: async () => [],
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

	test("subscribes to all compaction and context events", () => {
		const original = globalThis.EventSource;
		const names: string[] = [];
		globalThis.EventSource = class {
			addEventListener(name: string) { names.push(name); }
			close() {}
		} as unknown as typeof EventSource;
		try {
			const api = new Api({ baseUrl: "http://example.test", token: "secret" });
			api.subscribe({ onEvent() {} }, 0)();
			for (const name of ["compaction_started", "compaction_finished", "compaction_failed", "context_updated"]) expect(names).toContain(name);
		} finally { globalThis.EventSource = original; }
	});
});

describe("ask_user questions", () => {
	const asked = { toolCallId: "c1", toolName: "ask_user", question: "Which one?", options: ["red", "blue"], allowFreeText: false };

	test("a question marks its tool call as waiting and keeps what was asked", async () => {
		const { chat } = setup();
		await chat.load();
		chat.apply(event("question_requested", { sessionId: "session", ...asked, requestedAt: 1 }));
		const run = chat.tools.c1!;
		expect(run.state).toBe("awaiting_approval");
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
