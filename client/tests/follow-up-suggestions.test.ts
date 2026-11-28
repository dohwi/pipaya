import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";

let ChatState: typeof ChatStateType;
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pipaya-followups-"));
	const build = await Bun.build({
		entrypoints: [resolve("src/lib/chat.svelte.ts")],
		target: "bun",
		plugins: [
			{
				name: "runes",
				setup(builder) {
					builder.onResolve({ filter: /\/src\/lib\/(api|i18n)\.ts$/ }, ({ path }) => ({ path, external: true }));
					builder.onLoad({ filter: /chat\.svelte\.ts$/ }, async ({ path }) => {
						const source = ts.transpileModule(await Bun.file(path).text(), {
							compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
						}).outputText;
						const linked = source
							.replace('from "./api"', `from ${JSON.stringify(resolve("src/lib/api.ts"))}`)
							.replace('from "./i18n"', `from ${JSON.stringify(resolve("src/lib/i18n.ts"))}`);
						return { contents: compileModule(linked, { filename: path, generate: "client" }).js.code, loader: "js" };
					});
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const file = join(dir, "chat.mjs");
	await writeFile(file, await build.outputs[0]!.text());
	const mod = await import(file);
	ChatState = mod.ChatState;
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

const baseStatus = {
	running: false,
	compacting: false,
	pendingToolCalls: [],
	pendingQuestions: 0,
	queued: false,
	queuedMessages: [],
	streamingMessage: null,
	lastError: null,
};

const makeChat = (opts: {
	msgs?: { seq: number; message: unknown; createdAt: number }[];
	status?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
} = {}) => {
	const msgs = opts.msgs ?? [
		{ seq: 0, message: { role: "user", content: "Hello", timestamp: 1 }, createdAt: 1 },
		{ seq: 1, message: { role: "assistant", content: [{ type: "text", text: "Hi!" }], stopReason: "stop", timestamp: 2 }, createdAt: 2 },
	];
	const api = {
		tailMessages: async () => msgs,
		questions: async () => [],
		serverExtensionEntries: async () => [],
		getSession: async () => ({
			status: opts.status ? await opts.status() : baseStatus,
			context: { tokens: 10, contextWindow: 128000 },
			usage: {},
		}),
	} as unknown as Api;
	return new ChatState("session", api);
};

describe("ChatState follow-up suggestions", () => {
	test("hydrates suggestions on load when idle and hides them when busy or awaiting questions", async () => {
		const idle = makeChat({
			status: () => ({ ...baseStatus, followUpSuggestions: ["테스트 실행해 줘", "  ", "문서 확인해 줘"] }),
		});
		await idle.load();
		expect(idle.suggestions).toEqual(["테스트 실행해 줘", "문서 확인해 줘"]);

		const busy = makeChat({
			status: () => ({ ...baseStatus, running: true, followUpSuggestions: ["ignored"] }),
		});
		await busy.load();
		expect(busy.suggestions).toEqual([]);

		const asking = makeChat({
			status: () => ({ ...baseStatus, pendingQuestions: 1, followUpSuggestions: ["ignored"] }),
		});
		await asking.load();
		expect(asking.suggestions).toEqual([]);
	});

	test("applies matching follow_up_suggestions events, rejects stale afterSeq, and clears on run/message/question/optimistic send", async () => {
		const chat = makeChat();
		await chat.load();

		// Stale afterSeq is ignored
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 10, data: { afterSeq: 0, suggestions: ["Stale"] } });
		expect(chat.suggestions).toEqual([]);

		// Matching afterSeq is accepted
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 11, data: { afterSeq: 1, suggestions: ["Next step", "Show example"] } });
		expect(chat.suggestions).toEqual(["Next step", "Show example"]);

		// Empty array clears
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 12, data: { afterSeq: -1, suggestions: [] } });
		expect(chat.suggestions).toEqual([]);

		// Re-populate then clear on run_started
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 13, data: { afterSeq: 1, suggestions: ["A"] } });
		chat.apply({ id: 1, sessionId: "session", type: "run_started", ts: 14, data: { mode: "prompt", origin: "user" } });
		expect(chat.suggestions).toEqual([]);

		// Suggestions arriving while running are ignored
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 15, data: { afterSeq: 1, suggestions: ["While running"] } });
		expect(chat.suggestions).toEqual([]);

		// Finish run, populate, then clear on addOptimisticUser
		chat.apply({ id: 2, sessionId: "session", type: "run_finished", ts: 16, data: { status: "ok", error: null, durationMs: 10, origin: "user", usage: {} } });
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 17, data: { afterSeq: 1, suggestions: ["Click me"] } });
		expect(chat.suggestions).toEqual(["Click me"]);
		chat.addOptimisticUser("Click me", []);
		expect(chat.suggestions).toEqual([]);

		// Populate, then clear on question_requested and ignore suggestions while awaitingQuestion
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 18, data: { afterSeq: 1, suggestions: ["Before question"] } });
		chat.apply({ id: 3, sessionId: "session", type: "question_requested", ts: 19, data: { toolCallId: "q1", question: "Pick one", options: ["A", "B"] } });
		expect(chat.suggestions).toEqual([]);
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 20, data: { afterSeq: 1, suggestions: ["During question"] } });
		expect(chat.suggestions).toEqual([]);
	});

	test("a slow catchUp snapshot does not overwrite fresher live follow_up_suggestions", async () => {
		let release!: (s: Record<string, unknown>) => void;
		let slow = false;
		const chat = makeChat({
			status: () => (slow ? new Promise((r) => { release = r; }) : baseStatus),
		});
		await chat.load();

		slow = true;
		const pending = chat.catchUp();
		// Live suggestions arrive while catchUp is in flight
		chat.apply({ id: 0, sessionId: "session", type: "follow_up_suggestions", ts: 30, data: { afterSeq: 1, suggestions: ["Fresh live"] } });
		release({ ...baseStatus, followUpSuggestions: undefined });
		await pending;
		expect(chat.suggestions).toEqual(["Fresh live"]);
	});
});
