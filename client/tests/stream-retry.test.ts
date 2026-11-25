import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import type { Api } from "../src/lib/api";
import type { ChatState as ChatStateType } from "../src/lib/chat.svelte";
import type { PipayaEvent } from "../src/lib/types";

let ChatState: typeof ChatStateType;
let dir: string;
beforeAll(async () => {
	// Compile the real rune module with Svelte, rather than substituting fake $state globals.
	dir = await mkdtemp(join(tmpdir(), "pipaya-stream-retry-"));
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

const setup = () => {
	const api = {
		messages: async () => [], tailMessages: async () => [], approvals: async () => [], questions: async () => [],
		getSession: async () => ({ status: { running: false, pendingToolCalls: [], streamingMessage: null, compacting: false }, context: { tokens: 10, contextWindow: 128000 }, usage: {} }),
	} as unknown as Api;
	return new ChatState("session", api);
};
const event = (type: string, data: unknown = {}): PipayaEvent => ({ id: 1, sessionId: "session", type, data, ts: Date.now() });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() });

/** What the client shows for a reply that streamed a bit and then died: the partial text, marked stopped. */
const streamThenFail = (chat: InstanceType<typeof ChatStateType>, text: string, seq: number) => {
	chat.apply(event("run_started", { mode: "prompt" }));
	chat.apply(event("message_start", { message: assistant("") }));
	chat.apply(event("message_update", { event: { type: "text_delta", contentIndex: 0, delta: text } }));
	chat.apply(event("message_end", { seq, message: assistant(text, "error") }));
};

describe("a reply cut off mid-stream", () => {
	test("is dropped from the transcript when the retried answer starts", () => {
		const chat = setup();
		streamThenFail(chat, "half an ans", 3);
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);
		expect(chat.retrying).toBeNull();

		chat.apply(event("run_retrying", { attempt: 1, maxRetries: 3, delayMs: 2000, restart: true }));
		expect(chat.retrying).toMatchObject({ attempt: 1, maxRetries: 3, delayMs: 2000, reason: "" });
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(0);

		// The retried answer replaces it under the same seq, so a reload shows it once and message_end is applied.
		chat.apply(event("message_start", { message: assistant("") }));
		chat.apply(event("message_update", { event: { type: "text_delta", contentIndex: 0, delta: "the whole answer" } }));
		chat.apply(event("message_end", { seq: 3, message: assistant("the whole answer") }));
		const items = chat.items.filter((i) => i.kind === "assistant");
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ seq: 3, stopReason: "stop", streaming: false });
		expect(JSON.stringify(items[0])).not.toContain("half an ans");
		expect(JSON.stringify(items[0])).toContain("the whole answer");
	});

	test("a retry before anything streamed leaves the previous answer alone", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 1, message: assistant("earlier answer") }));
		chat.apply(event("run_started", { mode: "prompt" }));
		chat.apply(event("run_retrying", { attempt: 1, maxRetries: 6, delayMs: 2000 }));
		expect(chat.retrying).toMatchObject({ attempt: 1, maxRetries: 6, delayMs: 2000, reason: "" });
		expect(JSON.stringify(chat.items)).toContain("earlier answer");
	});

	test("manual retry drops trailing error reply and accepts the replacement at the same seq", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 1, message: { role: "user", content: [{ type: "text", text: "fix it" }], timestamp: Date.now() } }));
		streamThenFail(chat, "partial", 2);
		chat.apply(event("run_finished", { status: "error", error: "upstream boom" }));
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);

		chat.apply(event("run_started", { mode: "retry", origin: "user", droppedSeq: 2 }));
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(0);

		chat.apply(event("message_start", { message: assistant("") }));
		chat.apply(event("message_update", { event: { type: "text_delta", contentIndex: 0, delta: "fixed" } }));
		chat.apply(event("message_end", { seq: 2, message: assistant("fixed") }));
		chat.apply(event("run_finished", { status: "ok" }));

		const replies = chat.items.filter((i) => i.kind === "assistant");
		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({ seq: 2, stopReason: "stop", streaming: false });
		expect(JSON.stringify(replies[0])).toContain("fixed");
	});

	test("replayed retry run_started never drops a newer completed reply or an unrelated failed reply", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 2, message: assistant("already succeeded", "stop") }));
		chat.apply(event("run_started", { mode: "retry", origin: "user", droppedSeq: 2 }));
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(1);

		// A replayed retry without droppedSeq must not drop a later failed reply either.
		chat.apply(event("message_end", { seq: 3, message: assistant("later failure", "error") }));
		chat.apply(event("run_started", { mode: "retry", origin: "user" }));
		expect(chat.items.filter((i) => i.kind === "assistant")).toHaveLength(2);
	});

	test("run_finished error after a completed reply is not marked resumable, and standalone user prompt stays unsettled", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 1, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } }));
		expect(chat.settled).toBe(false);
		chat.apply(event("run_started", { mode: "prompt" }));
		chat.apply(event("message_end", { seq: 2, message: assistant("done", "stop") }));
		chat.apply(event("run_finished", { status: "error", error: "post-run hook failed" }));
		expect(chat.settled).toBe(true);
		expect(chat.items.at(-1)).toMatchObject({ kind: "notice", tone: "error", resumable: false, text: "post-run hook failed" });
	});

	test("run_limit drops empty failed reply, rolls back lastSeq, and manual retry clears the limit notice", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 1, message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() } }));
		chat.apply(event("run_started", { mode: "prompt" }));
		chat.apply(event("message_end", { seq: 2, message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } }));
		chat.apply(event("message_end", { seq: 3, message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() } }));
		chat.apply(event("run_limit", { reason: "Stopped after 200 model calls" }));
		chat.apply(event("message_end", { seq: 4, message: { role: "assistant", content: [], stopReason: "aborted", timestamp: Date.now() } }));
		chat.apply(event("run_finished", { status: "aborted", cause: "limit" }));

		const notice = chat.items.at(-1);
		expect(notice).toMatchObject({ kind: "notice", tone: "warn", resumable: true, text: "Stopped after 200 model calls" });

		// Retry clears the limit notice and accepts the continued reply at seq 4.
		chat.apply(event("run_started", { mode: "retry", origin: "user" }));
		expect(chat.items.some((i) => i.kind === "notice")).toBe(false);
		chat.apply(event("message_end", { seq: 4, message: assistant("done now", "stop") }));
		expect(chat.items.at(-1)).toMatchObject({ kind: "assistant", seq: 4, stopReason: "stop" });
	});

	test("a pre-reply error after an earlier error turn still adds a resumable error notice", () => {
		const chat = setup();
		chat.apply(event("message_end", { seq: 1, message: { role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() } }));
		chat.apply(event("message_end", { seq: 2, message: assistant("old fail", "error") }));
		chat.apply(event("message_end", { seq: 3, message: { role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() } }));
		chat.apply(event("run_started", { mode: "prompt" }));
		chat.apply(event("run_finished", { status: "error", error: "network down" }));
		expect(chat.items.at(-1)).toMatchObject({ kind: "notice", tone: "error", resumable: true, text: "network down" });
	});
});
